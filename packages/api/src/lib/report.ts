import fs from 'fs'
import path from 'path'
import { db } from './db'

const OUTPUT_FOLDER = process.env.OUTPUT_FOLDER ?? ''

// ─── Keyword matching ─────────────────────────────────────────────────────────
//
// Check longer / more-specific phrases first so "tidak tau" beats "tidak"
// and "nggak dapat" beats "nggak".

const POSITIVE_KEYWORDS = [
  'sudah ada',
  'pernah ada',
  'ada penukaran',
  'benar ada',
  'iya ada',
  'ya ada',
  'sudah',
  'benar',
  'betul',
  'pernah',
  'iya',
  'yes',
  'ya',
]

const NEGATIVE_KEYWORDS = [
  'tidak tau',
  'tidak tahu',
  'nggak tau',
  'nggak tahu',
  'ngga tau',
  'belum ada',
  'tidak ada',
  'nggak ada',
  'ngga ada',
  'gak ada',
  'tidak dapat',
  'nggak dapat',
  'ngga dapat',
  'tidak pernah',
  'belum pernah',
  'tidak',
  'nggak',
  'ngga',
  'ndak',
  'gak',
  'blm',
  'no',
]

export type Jawaban = 1 | 0

/**
 * Determine 1 (positive) or 0 (negative) from a reply.
 * Returns null if the reply is ambiguous / no clear answer.
 *
 * Priority:
 *   1. Keyword matching on raw reply text (longer phrases checked first)
 *   2. Claude's claudeCategory as fallback
 */
export function determineJawaban(
  body: string | null | undefined,
  claudeCategory: string | null | undefined,
): Jawaban | null {
  if (body) {
    const lower = body.toLowerCase().trim()

    // Negative takes priority over positive to avoid false positives
    // (e.g. "ya, tidak ada" should be 0)
    if (NEGATIVE_KEYWORDS.some((k) => lower.includes(k))) return 0
    if (POSITIVE_KEYWORDS.some((k) => lower.includes(k))) return 1
  }

  // Fallback to Claude's analysis
  if (claudeCategory === 'confirmed') return 1
  if (claudeCategory === 'denied') return 0

  return null // question / unclear / other — excluded from report
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function csvEscape(value: string): string {
  // Wrap in quotes if value contains comma, quote, or newline
  if (/[,"\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

// ─── Report generator ─────────────────────────────────────────────────────────

/**
 * Regenerate the CSV report for one area.
 *
 * Output path: OUTPUT_FOLDER/{Department Name}/{Area Name}.csv
 *
 * Only includes contacts that have replied with a clear Yes (1) or No (0).
 * Re-running is idempotent — the file is fully rewritten each time.
 */
export async function generateAreaReport(areaId: string): Promise<string | null> {
  if (!OUTPUT_FOLDER) {
    console.warn('[report] OUTPUT_FOLDER is not set, skipping CSV generation')
    return null
  }

  const contacts = await db.contact.findMany({
    where: { areaId, phoneValid: true },
    include: {
      area: { include: { department: true } },
      messages: {
        where: { status: { in: ['SENT', 'DELIVERED', 'READ'] } },
        include: { reply: true },
        orderBy: { sentAt: 'desc' },
        take: 1,
      },
    },
    orderBy: [{ seqNo: 'asc' }, { storeName: 'asc' }],
  })

  if (contacts.length === 0) return null

  const area = contacts[0].area
  const dept = area.department

  // Build rows — only contacts with a clear answer
  const rows: Array<{ namaToko: string; nomorHp: string; jawaban: Jawaban }> = []

  for (const contact of contacts) {
    const reply = contact.messages[0]?.reply
    const jawaban = determineJawaban(reply?.body, reply?.claudeCategory)
    if (jawaban === null) continue

    rows.push({
      namaToko: contact.storeName,
      nomorHp: contact.phoneNorm,
      jawaban,
    })
  }

  if (rows.length === 0) return null

  // Write CSV
  const dir = path.join(OUTPUT_FOLDER, dept.name)
  fs.mkdirSync(dir, { recursive: true })

  const csvPath = path.join(dir, `${area.name}.csv`)
  const header = 'Nama Toko,Nomor HP Toko,Jawaban'
  const lines = rows.map(
    (r) => `${csvEscape(r.namaToko)},${csvEscape(r.nomorHp)},${r.jawaban}`,
  )

  fs.writeFileSync(csvPath, [header, ...lines].join('\n'), 'utf-8')

  console.log(`[report] wrote ${rows.length} row(s) → ${csvPath}`)
  return csvPath
}

/**
 * Regenerate CSV reports for ALL areas that have at least one analyzed reply.
 * Useful for bulk re-export or recovery.
 */
export async function generateAllReports(): Promise<string[]> {
  const areas = await db.area.findMany({
    where: {
      contacts: {
        some: {
          messages: {
            some: {
              reply: { claudeCategory: { not: null } },
            },
          },
        },
      },
    },
    select: { id: true },
  })

  const paths: string[] = []
  for (const area of areas) {
    const p = await generateAreaReport(area.id)
    if (p) paths.push(p)
  }
  return paths
}
