import ExcelJS from 'exceljs'
import fs from 'fs'
import path from 'path'
import { db } from './db'

const OUTPUT_FOLDER = process.env.OUTPUT_FOLDER ?? ''

const IMG_W          = 240
const IMG_H          = 180
const ROW_H_WITH_IMG = Math.ceil(IMG_H * 0.75) + 6  // ~141pt
const ROW_H_DEFAULT  = 18

/**
 * Build an XLSX workbook for a campaign — one sheet per area.
 *
 * Columns: No | Nama Toko | Nomor HP | Department | Area | Agent Phone | Jawaban | Screenshot
 * Screenshots are embedded as images in column H.
 *
 * Includes ALL contacts with a SENT/DELIVERED/READ message — not just replied ones.
 * Contacts without a reply show blank Jawaban and no Screenshot.
 */
export async function buildCampaignReportXlsx(campaignId: string): Promise<Buffer> {
  const campaign = await db.campaign.findUnique({
    where:   { id: campaignId },
    include: { areas: { include: { area: { include: { department: true } } } } },
  })
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`)

  const workbook       = new ExcelJS.Workbook()
  workbook.creator     = 'AICE WhatsApp Automation'
  workbook.created     = new Date()

  let totalRows = 0

  for (const ca of campaign.areas) {
    const area = ca.area
    const dept = area.department

    const contacts = await db.contact.findMany({
      where: { areaId: area.id, phoneValid: true },
      include: {
        messages: {
          where:   { campaignId, status: { in: ['SENT', 'DELIVERED', 'READ'] } },
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

    // Only include contacts that were actually sent a message
    const sentContacts = contacts.filter((c) => c.messages.length > 0)
    if (sentContacts.length === 0) continue

    const sheetName = area.name.slice(0, 31)
    const sheet     = workbook.addWorksheet(sheetName)

    sheet.columns = [
      { key: 'no',          width: 5  },
      { key: 'storeName',   width: 28 },
      { key: 'phone',       width: 20 },
      { key: 'dept',        width: 18 },
      { key: 'areaName',    width: 20 },
      { key: 'agentPhone',  width: 18 },
      { key: 'jawaban',     width: 12 },
      { key: 'screenshot',  width: 32 },
    ]

    // Header row
    const headers   = ['No', 'Nama Toko', 'Nomor HP Toko', 'Department', 'Area', 'Agent Phone', 'Jawaban', 'Screenshot']
    const headerRow = sheet.addRow(headers)
    headerRow.height = 22
    headerRow.eachCell((cell) => {
      cell.font      = { bold: true, color: { argb: 'FF1F2937' } }
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }
      cell.alignment = { vertical: 'middle', horizontal: 'center' }
      cell.border    = { bottom: { style: 'medium', color: { argb: 'FFD1D5DB' } } }
    })

    let rowNo = 1
    for (const contact of sentContacts) {
      const message     = contact.messages[0]
      const reply       = message?.reply
      const agentPhone  = message?.agent?.phoneNumber ?? ''
      const hasReply    = reply?.jawaban != null
      const jawaban     = hasReply ? (reply!.jawaban as 0 | 1) : null
      const jawabanLabel = jawaban === 1 ? 'Ya ✓' : jawaban === 0 ? 'Tidak ✗' : ''
      const jawabanColor = jawaban === 1 ? 'FFD1FAE5' : jawaban === 0 ? 'FFFEE2E2' : 'FFFFFFFF'
      const excelRowIdx = rowNo + 1

      const absPath = reply?.screenshotPath && OUTPUT_FOLDER
        ? path.join(OUTPUT_FOLDER, reply.screenshotPath)
        : null
      const hasImg  = absPath !== null && fs.existsSync(absPath)

      const dataRow = sheet.addRow([rowNo, contact.storeName, contact.phoneNorm, dept.name, area.name, agentPhone, jawabanLabel, ''])
      dataRow.height = hasImg ? ROW_H_WITH_IMG : ROW_H_DEFAULT

      dataRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' }
      dataRow.getCell(2).alignment = { vertical: 'middle', wrapText: true }
      dataRow.getCell(3).alignment = { vertical: 'middle' }
      dataRow.getCell(3).font      = { color: { argb: 'FF6B7280' } }
      dataRow.getCell(4).alignment = { vertical: 'middle' }
      dataRow.getCell(5).alignment = { vertical: 'middle' }
      dataRow.getCell(6).alignment = { vertical: 'middle', horizontal: 'center' }
      dataRow.getCell(6).font      = { color: { argb: 'FF6B7280' } }

      const jawabanCell     = dataRow.getCell(7)
      jawabanCell.alignment = { vertical: 'middle', horizontal: 'center' }
      if (hasReply) {
        jawabanCell.font = { bold: true, color: { argb: jawaban === 1 ? 'FF065F46' : 'FF991B1B' } }
        jawabanCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: jawabanColor } }
      } else {
        jawabanCell.font  = { italic: true, color: { argb: 'FF9CA3AF' } }
        jawabanCell.value = 'Pending'
      }

      if (rowNo % 2 === 0) {
        for (let c = 1; c <= 6; c++) {
          const cell = dataRow.getCell(c)
          if (!(cell.fill as ExcelJS.FillPattern)?.fgColor) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAFA' } }
          }
        }
      }

      if (hasImg) {
        try {
          const ext       = path.extname(absPath).toLowerCase().replace('.', '')
          const extension = (ext === 'jpg' ? 'jpeg' : ext) as 'jpeg' | 'png' | 'gif'
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const imageId   = workbook.addImage({ buffer: fs.readFileSync(absPath) as any, extension })
          // col 7 = column H (0-indexed), row = excelRowIdx - 1 (0-indexed)
          sheet.addImage(imageId, {
            tl:     { col: 7, row: excelRowIdx - 1 },
            ext:    { width: IMG_W, height: IMG_H },
            editAs: 'oneCell',
          })
        } catch {
          dataRow.getCell(8).value     = absPath
          dataRow.getCell(8).font      = { italic: true, color: { argb: 'FF9CA3AF' } }
          dataRow.getCell(8).alignment = { vertical: 'middle', wrapText: true }
        }
      }

      dataRow.commit()
      rowNo++
      totalRows++
    }
  }

  // Info sheet
  const meta = workbook.addWorksheet('Info')
  meta.addRow(['Laporan AICE WhatsApp Automation'])
  meta.addRow(['Campaign',    campaign.name])
  meta.addRow(['Tipe',        campaign.campaignType])
  meta.addRow(['Bulan',       campaign.bulan])
  meta.addRow(['Dibuat',      new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })])
  meta.addRow(['Total baris', totalRows])
  meta.getRow(1).font = { bold: true, size: 13 }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Buffer.from((await workbook.xlsx.writeBuffer()) as any)
}
