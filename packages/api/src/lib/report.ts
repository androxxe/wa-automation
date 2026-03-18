import { db } from './db'
import { uploadBuffer } from './minio'

function csvEscape(value: string): string {
  if (/[,"\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

/**
 * Regenerate the CSV report for one (area x bulan x campaignType) combination.
 *
 * Output: MinIO key: reports/csv/{Type}/{Department}/{Area}_{Bulan}_{YYYY-MM-DD}.csv
 *
 * Columns: Nama Toko, Nomor HP Toko, Department, Area, Agent Phone, Jawaban, Screenshot
 *
 * Includes ALL contacts with a SENT/DELIVERED/READ message — not just replied ones.
 * Contacts without a reply show blank Jawaban and Screenshot.
 * Fully rewritten on each call (idempotent).
 */
export async function generateAreaReport(
  areaId:       string,
  bulan:        string,
  campaignType: string,
): Promise<string | null> {
  const contacts = await db.contact.findMany({
    where: { areaId, phoneValid: true },
    include: {
      area: { include: { department: true } },
      messages: {
        where: {
          status:   { in: ['SENT', 'DELIVERED', 'READ'] },
          campaign: { bulan, campaignType },
        },
        include: {
          reply: true,
          agent: { select: { phoneNumber: true } },
        },
        orderBy: { sentAt: 'desc' },
        take:    1,
      },
    },
    orderBy: [{ seqNo: 'asc' }, { storeName: 'asc' }],
  })

  // Only include contacts that have at least one sent message for this campaign
  const sentContacts = contacts.filter((c) => c.messages.length > 0)
  if (sentContacts.length === 0) return null

  const area = sentContacts[0].area
  const dept = area.department

  const rows = sentContacts.map((contact) => {
    const message   = contact.messages[0]
    const reply     = message?.reply
    const agentPhone = message?.agent?.phoneNumber ?? ''
    // null jawaban (unclear/question/other) counts as 0 (Tidak) in the report
    const jawaban   = reply != null ? String(reply.jawaban ?? 0) : ''
    const kategori  = reply?.claudeCategory ?? ''
    const screenshot = reply?.screenshotPath ?? ''

    return {
      namaToko:    contact.storeName,
      nomorHp:     contact.phoneNorm,
      department:  dept.name,
      areaName:    area.name,
      agentPhone,
      jawaban,
      kategori,
      screenshot,
    }
  })

  const today   = new Date().toISOString().slice(0, 10)
  const key     = `reports/csv/${campaignType}/${dept.name}/${area.name}_${bulan}_${today}.csv`
  const header  = 'Nama Toko,Nomor HP Toko,Department,Area,Agent Phone,Jawaban,Kategori,Screenshot'
  const lines   = rows.map((r) =>
    [
      csvEscape(r.namaToko),
      csvEscape(r.nomorHp),
      csvEscape(r.department),
      csvEscape(r.areaName),
      csvEscape(r.agentPhone),
      r.jawaban,
      csvEscape(r.kategori),
      csvEscape(r.screenshot),
    ].join(','),
  )

  const csvContent = [header, ...lines].join('\n')
  await uploadBuffer(key, Buffer.from(csvContent, 'utf-8'), 'text/csv')
  console.log(`[report] ${rows.length} row(s) → minio:${key}`)
  return key
}

/**
 * Regenerate CSV reports for all (area x bulan x campaignType) combos
 * that have at least one sent message.
 */
export async function generateAllReports(): Promise<string[]> {
  const msgs = await db.message.findMany({
    where:  { status: { in: ['SENT', 'DELIVERED', 'READ'] } },
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
