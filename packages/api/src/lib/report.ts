import fs from 'fs'
import path from 'path'
import { db } from './db'

const OUTPUT_FOLDER = process.env.OUTPUT_FOLDER ?? ''

export type Jawaban = 1 | 0

/**
 * Determine Jawaban purely from Claude's category.
 *   confirmed → 1 (Ya)
 *   denied    → 0 (Tidak)
 *   anything else → null (excluded from report)
 */
export function determineJawaban(
  claudeCategory: string | null | undefined,
): Jawaban | null {
  if (claudeCategory === 'confirmed') return 1
  if (claudeCategory === 'denied') return 0
  return null
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
  const rows: Array<{
    namaToko: string
    nomorHp: string
    jawaban: Jawaban
    screenshotPath: string
  }> = []

  for (const contact of contacts) {
    const reply = contact.messages[0]?.reply
    // Use AI-determined jawaban stored on the reply record.
    // null means Claude couldn't classify (question/unclear/other) — excluded.
    if (reply?.jawaban == null) continue
    const jawaban = reply.jawaban as Jawaban

    // Screenshot path: relative to OUTPUT_FOLDER, stored in reply.screenshotPath
    // Full path = OUTPUT_FOLDER/{screenshotPath}
    const screenshotPath = reply?.screenshotPath
      ? path.join(OUTPUT_FOLDER, reply.screenshotPath)
      : ''

    rows.push({
      namaToko: contact.storeName,
      nomorHp: contact.phoneNorm,
      jawaban,
      screenshotPath,
    })
  }

  if (rows.length === 0) return null

  // Write CSV — filename includes date so users can see when data was last updated.
  // Same date = file is overwritten. New date = new file alongside previous ones.
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const dir = path.join(OUTPUT_FOLDER, dept.name)
  fs.mkdirSync(dir, { recursive: true })

  const csvPath = path.join(dir, `${area.name}_${today}.csv`)
  // Screenshot column stores the absolute path to the .jpg file.
  // Images can't be embedded in CSV — open the path in any viewer.
  const header = 'Nama Toko,Nomor HP Toko,Jawaban,Screenshot'
  const lines = rows.map(
    (r) =>
      `${csvEscape(r.namaToko)},${csvEscape(r.nomorHp)},${r.jawaban},${csvEscape(r.screenshotPath)}`,
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
