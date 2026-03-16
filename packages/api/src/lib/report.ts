import fs from 'fs'
import path from 'path'
import { db } from './db'

const OUTPUT_FOLDER = process.env.OUTPUT_FOLDER ?? ''

export type Jawaban = 1 | 0

function csvEscape(value: string): string {
  if (/[,"\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

/**
 * Regenerate the CSV report for one (area × bulan × campaignType) combination.
 *
 * Output: OUTPUT_FOLDER/{Type}/{Department}/{Area}_{Bulan}_{YYYY-MM-DD}.csv
 *
 * Columns: Nama Toko, Nomor HP Toko, Department, Area, Jawaban, Screenshot
 * Only contacts with jawaban = 1 or 0 are included.
 * Fully rewritten on each call (idempotent).
 */
export async function generateAreaReport(
  areaId:       string,
  bulan:        string,
  campaignType: string,
): Promise<string | null> {
  if (!OUTPUT_FOLDER) {
    console.warn('[report] OUTPUT_FOLDER not set, skipping CSV generation')
    return null
  }

  const contacts = await db.contact.findMany({
    where: { areaId, phoneValid: true },
    include: {
      area: { include: { department: true } },
      messages: {
        where: {
          status:   { in: ['SENT', 'DELIVERED', 'READ'] },
          campaign: { bulan, campaignType },
        },
        include:  { reply: true },
        orderBy:  { sentAt: 'desc' },
        take:     1,
      },
    },
    orderBy: [{ seqNo: 'asc' }, { storeName: 'asc' }],
  })

  if (contacts.length === 0) return null

  const area = contacts[0].area
  const dept = area.department

  const rows: Array<{
    namaToko:       string
    nomorHp:        string
    department:     string
    areaName:       string
    jawaban:        Jawaban
    screenshotPath: string
  }> = []

  for (const contact of contacts) {
    const reply = contact.messages[0]?.reply
    if (reply?.jawaban == null) continue

    rows.push({
      namaToko:       contact.storeName,
      nomorHp:        contact.phoneNorm,
      department:     dept.name,
      areaName:       area.name,
      jawaban:        reply.jawaban as Jawaban,
      screenshotPath: reply.screenshotPath
        ? path.join(OUTPUT_FOLDER, reply.screenshotPath)
        : '',
    })
  }

  if (rows.length === 0) return null

  const today   = new Date().toISOString().slice(0, 10)
  const dir     = path.join(OUTPUT_FOLDER, campaignType, dept.name)
  fs.mkdirSync(dir, { recursive: true })

  const csvPath = path.join(dir, `${area.name}_${bulan}_${today}.csv`)
  const header  = 'Nama Toko,Nomor HP Toko,Department,Area,Jawaban,Screenshot'
  const lines   = rows.map(
    (r) =>
      `${csvEscape(r.namaToko)},${csvEscape(r.nomorHp)},${csvEscape(r.department)},${csvEscape(r.areaName)},${r.jawaban},${csvEscape(r.screenshotPath)}`,
  )

  fs.writeFileSync(csvPath, [header, ...lines].join('\n'), 'utf-8')
  console.log(`[report] ${rows.length} row(s) → ${csvPath}`)
  return csvPath
}

/**
 * Regenerate CSV reports for all (area × bulan × campaignType) combos
 * that have at least one analyzed reply.
 */
export async function generateAllReports(): Promise<string[]> {
  const msgs = await db.message.findMany({
    where: {
      status: { in: ['SENT', 'DELIVERED', 'READ'] },
      reply:  { claudeCategory: { not: null } },
    },
    select: {
      campaign: { select: { bulan: true, campaignType: true } },
      contact:  { select: { areaId: true } },
    },
  })

  const seen  = new Set<string>()
  const paths: string[] = []

  for (const msg of msgs) {
    const key = `${msg.contact.areaId}|${msg.campaign.bulan}|${msg.campaign.campaignType}`
    if (seen.has(key)) continue
    seen.add(key)
    const p = await generateAreaReport(
      msg.contact.areaId,
      msg.campaign.bulan,
      msg.campaign.campaignType,
    )
    if (p) paths.push(p)
  }

  return paths
}
