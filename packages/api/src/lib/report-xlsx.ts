import ExcelJS from 'exceljs'
import fs from 'node:fs'
import path from 'node:path'
import { db } from './db'

const OUTPUT_FOLDER = process.env.OUTPUT_FOLDER ?? ''

const IMG_W          = 240
const IMG_H          = 180
const ROW_H_WITH_IMG = Math.ceil(IMG_H * 0.75) + 6  // ~141pt
const ROW_H_DEFAULT  = 18

export interface ReportXlsxOptions {
  /** Embed screenshots as images in the workbook (legacy). Default true. */
  embedImages?: boolean
  /** Collect each existing screenshot (zip mode) — invoked with its archive path. */
  onPhoto?: (photo: { archivePath: string; absPath: string }) => void
  /** Subset of column keys to include. Absent = all supported columns. */
  columns?: string[]
}

function sanitizeDirName(name: string): string {
  return name
    .replace(/\s+/g, '_')
    .replace(/[\\/:*?"<>|-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100)
}

function sanitizeFileName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').slice(0, 80)
}

// Excel limits sheet names to 31 chars and forbids : \ / ? * [ ].
// Names must be unique (case-insensitive) across the workbook.
function uniqueSheetName(used: Set<string>, base: string): string {
  const root = base
    .replace(/[\\/:*?"<>|[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31) || 'Sheet'

  let name = root
  let n = 2
  while (used.has(name.toLowerCase())) {
    const suffix = `_${n}`
    name = `${root.slice(0, 31 - suffix.length)}${suffix}`
    n++
  }
  used.add(name.toLowerCase())
  return name
}

function extractScreenshotTimestamp(screenshotPath: string | null): string {
  const match = screenshotPath?.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/)
  if (match) return match[1]
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

// Archive path + reference text for zip mode: screenshots/<CampaignName_>/<phone>_<store>_<timestamp>.jpg
function buildScreenshotRef(
  campaignName: string,
  absPath: string,
  phone: string,
  storeName: string,
): { archivePath: string; ref: string } {
  const namePart = sanitizeFileName(storeName)
  const filename = `${phone.replace('+', '')}${namePart ? `_${namePart}` : ''}_${extractScreenshotTimestamp(absPath)}${path.extname(absPath) || '.jpg'}`
  const archivePath = `screenshots/${sanitizeDirName(campaignName)}/${filename}`
  return { archivePath, ref: archivePath }
}

// ─── Column selection ─────────────────────────────────────────────────────────
// Canonical column keys shared by every report builder. Each builder declares
// which of these it supports; `columns` from the query keeps their order.

export type ReportColumnKey =
  | 'no' | 'market' | 'storeName' | 'phone' | 'owner'
  | 'dept' | 'area' | 'agentPhone' | 'jawaban' | 'kategori'
  | 'status' | 'dikirimPada' | 'dibalasPada' | 'rawResponse' | 'screenshot'

const REPORT_COLUMN_WIDTHS: Record<ReportColumnKey, number> = {
  no: 5, market: 12, storeName: 28, phone: 20, owner: 28,
  dept: 18, area: 20, agentPhone: 18, jawaban: 12, kategori: 14,
  status: 12, dikirimPada: 20, dibalasPada: 20, rawResponse: 40, screenshot: 32,
}

const REPORT_COLUMN_HEADERS: Record<ReportColumnKey, string> = {
  no: 'No', market: 'Market', storeName: 'Nama Toko', phone: 'Nomor HP Toko', owner: 'Pemilik Toko',
  dept: 'Department', area: 'Area', agentPhone: 'Agent Phone', jawaban: 'Jawaban', kategori: 'Kategori',
  status: 'Status', dikirimPada: 'Dikirim pada', dibalasPada: 'Dibalas pada', rawResponse: 'Raw Response', screenshot: 'Screenshot',
}

// Columns each builder can render (canonical order).
const CAMPAIGN_SHEET_COLUMNS: ReportColumnKey[] = [
  'no', 'storeName', 'phone', 'dept', 'area', 'agentPhone', 'jawaban',
  'kategori', 'status', 'dikirimPada', 'dibalasPada', 'rawResponse', 'screenshot',
]
const DEPT_SHEET_COLUMNS: ReportColumnKey[] = [
  'no', 'market', 'storeName', 'phone', 'owner', 'agentPhone', 'jawaban',
  'kategori', 'status', 'dikirimPada', 'dibalasPada', 'rawResponse', 'screenshot',
]

function resolveColumns(requested: string[] | undefined, supported: ReportColumnKey[]): ReportColumnKey[] {
  if (!requested) return supported
  const want = new Set(requested.map((c) => c.trim()).filter(Boolean))
  const cols = supported.filter((k) => want.has(k))
  if (cols.length === 0) throw new Error('No valid columns selected')
  return cols
}

// 1-based ExcelJS column index for a key, or -1 when the column is excluded.
function colIdx(cols: ReportColumnKey[], key: ReportColumnKey): number {
  const i = cols.indexOf(key)
  return i === -1 ? -1 : i + 1
}

// Parse a `columns` query param: comma-separated and/or repeated (?columns=a&columns=b).
// Returns undefined when absent (meaning: all columns). Throws when present but empty.
export function parseReportColumns(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined
  const parts = (typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [])
    .flatMap((s) => String(s).split(','))
  const cols = [...new Set(parts.map((s) => s.trim()).filter(Boolean))]
  if (cols.length === 0) throw new Error('No valid columns selected')
  return cols
}

/**
 * Build an XLSX workbook for a campaign — one sheet per area.
 *
 * Columns: No | Nama Toko | Nomor HP | Department | Area | Agent Phone | Jawaban | Kategori | Status | Dikirim pada | Dibalas pada | Raw Response | Screenshot
 * Screenshots are embedded as images in column M by default (legacy).
 * Pass { embedImages: false, onPhoto } to collect screenshots for a ZIP archive instead (column M shows the archive path).
 *
 * Includes ALL contacts with a SENT/DELIVERED/READ message — not just replied ones.
 * Contacts without a reply show blank Jawaban and no Screenshot.
 * Invalid replies show "⚠ Invalid" in Status column with red background.
 */
export async function buildCampaignReportXlsx(campaignId: string, options?: ReportXlsxOptions): Promise<Buffer> {
  const campaign = await db.campaign.findUnique({
    where:   { id: campaignId },
    include: { areas: { include: { area: { include: { department: true } } } } },
  })
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`)

  const workbook       = new ExcelJS.Workbook()
  workbook.creator     = 'AICE WhatsApp Automation'
  workbook.created     = new Date()

  let totalRows = 0
  let totalInvalidReplies = 0
  const usedSheetNames = new Set<string>()

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

    const sheetName = uniqueSheetName(usedSheetNames, area.name)
    const sheet     = workbook.addWorksheet(sheetName)

    const cols = resolveColumns(options?.columns, CAMPAIGN_SHEET_COLUMNS)
    const at = (key: ReportColumnKey): number => colIdx(cols, key)

    sheet.columns = cols.map((key) => ({ key, width: REPORT_COLUMN_WIDTHS[key] }))

    // Header row
    const headers   = cols.map((key) => REPORT_COLUMN_HEADERS[key])
    const headerRow = sheet.addRow(headers)
    headerRow.height = 22
    headerRow.eachCell((cell) => {
      cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } }
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10B981' } }
      cell.alignment = { vertical: 'middle', horizontal: 'center' }
      cell.border    = { bottom: { style: 'medium', color: { argb: 'FF059669' } } }
    })

    let rowNo = 1
    for (const contact of sentContacts) {
      const message     = contact.messages[0]
      const reply       = message?.reply
      const agentPhone  = message?.agent?.phoneNumber ?? ''
      const hasReply    = reply != null
      // null jawaban (unclear/question/other) counts as 0 (Tidak) in the report
      const jawaban      = hasReply ? ((reply?.jawaban ?? 0) as 0 | 1) : null
      const jawabanLabel = jawaban === 1 ? 1 : jawaban === 0 ? 0 : ''
      const kategori     = reply?.claudeCategory ?? ''
      const isInvalid    = reply?.claudeCategory === 'invalid'
      const statusLabel  = isInvalid ? '⚠ Invalid' : (hasReply ? 'Valid' : '')
      const excelRowIdx  = rowNo + 1

      if (isInvalid) {
        totalInvalidReplies++
      }

      const fmtDate = (d: Date | null | undefined) =>
        d ? d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

      const dikirimPada = fmtDate(message?.sentAt)
      const dibalasPada = fmtDate(reply?.receivedAt)

      const rawResponse = reply?.body ?? ''

      const shotIdx = at('screenshot')
      const absPath = reply?.screenshotPath && OUTPUT_FOLDER
        ? path.join(OUTPUT_FOLDER, reply.screenshotPath)
        : null
      const hasImg  = shotIdx !== -1 && absPath !== null && fs.existsSync(absPath)
      const embed   = options?.embedImages !== false

      // Row values follow the selected column order
      const values: Record<ReportColumnKey, string | number> = {
        no: rowNo, market: '', storeName: contact.storeName, phone: contact.phoneNorm,
        owner: '', dept: dept.name, area: area.name, agentPhone,
        jawaban: jawabanLabel, kategori, status: statusLabel,
        dikirimPada, dibalasPada, rawResponse, screenshot: '',
      }
      const dataRow = sheet.addRow(cols.map((key) => values[key]))
      dataRow.height = hasImg && embed ? ROW_H_WITH_IMG : ROW_H_DEFAULT

      const withCell = (key: ReportColumnKey, fn: (cell: ExcelJS.Cell) => void): void => {
        const idx = at(key)
        if (idx !== -1) fn(dataRow.getCell(idx))
      }

      withCell('no', (c) => { c.alignment = { vertical: 'middle', horizontal: 'center' } })
      withCell('storeName', (c) => { c.alignment = { vertical: 'middle', wrapText: true } })
      withCell('phone', (c) => { c.alignment = { vertical: 'middle' }; c.font = { color: { argb: 'FF6B7280' } } })
      withCell('dept', (c) => { c.alignment = { vertical: 'middle' } })
      withCell('area', (c) => { c.alignment = { vertical: 'middle' } })
      withCell('agentPhone', (c) => { c.alignment = { vertical: 'middle', horizontal: 'center' }; c.font = { color: { argb: 'FF6B7280' } } })

      withCell('jawaban', (jawabanCell) => {
        jawabanCell.alignment = { vertical: 'middle', horizontal: 'center' }
        if (hasReply) {
          jawabanCell.font = { bold: true, color: { argb: jawaban === 1 ? 'FF065F46' : 'FF991B1B' } }
        } else {
          jawabanCell.font  = { italic: true, color: { argb: 'FF9CA3AF' } }
          jawabanCell.value = 'Pending'
        }
      })

      // Kategori cell (col 8)
      const kategoriColors: Record<string, string> = {
        confirmed: 'FF6EE7B7',
        denied:    'FFFCA5A5',
        question:  'FFFDE68A',
        unclear:   'FFE5E7EB',
        invalid:   'FFFBBF24',
        other:     'FFBFDBFE',
      }
      withCell('kategori', (kategoriCell) => {
        kategoriCell.alignment = { vertical: 'middle', horizontal: 'center' }
        if (kategori) {
          kategoriCell.font = { color: { argb: 'FF374151' } }
          kategoriCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: kategoriColors[kategori] ?? 'FFFFFFFF' } }
        }
      })

      // Status cell
      withCell('status', (statusCell) => {
        statusCell.alignment = { vertical: 'middle', horizontal: 'center' }
        if (isInvalid) {
          statusCell.font = { bold: true, color: { argb: 'FFDC2626' } }
          statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } }
        } else if (hasReply) {
          statusCell.font = { color: { argb: 'FF059669' } }
          statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } }
        }
      })

      withCell('dikirimPada', (c) => { c.alignment = { vertical: 'middle', horizontal: 'center' }; c.font = { color: { argb: 'FF6B7280' } } })
      withCell('dibalasPada', (c) => { c.alignment = { vertical: 'middle', horizontal: 'center' }; c.font = { color: { argb: 'FF6B7280' } } })
      withCell('rawResponse', (c) => { c.alignment = { vertical: 'middle', wrapText: true }; c.font = { color: { argb: 'FF374151' } } })

      if (rowNo % 2 === 0) {
        for (const key of ['no', 'storeName', 'phone', 'dept', 'area', 'agentPhone'] as const) {
          withCell(key, (cell) => {
            if (!(cell.fill as ExcelJS.FillPattern)?.fgColor) {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAFA' } }
            }
          })
        }
      }

       if (hasImg && !embed) {
         const { archivePath, ref } = buildScreenshotRef(campaign.name, absPath, contact.phoneNorm, contact.storeName)
         options?.onPhoto?.({ archivePath, absPath })
         withCell('screenshot', (c) => {
           c.value     = ref
           c.font      = { italic: true, color: { argb: 'FF9CA3AF' } }
           c.alignment = { vertical: 'middle', wrapText: true }
         })
       } else if (hasImg) {
         try {
           const ext       = path.extname(absPath).toLowerCase().replace('.', '')
           const extension = (ext === 'jpg' ? 'jpeg' : ext) as 'jpeg' | 'png' | 'gif'
           // ExcelJS declares its own Buffer type (extends ArrayBuffer) which clashes with Node Buffer; binary-compatible at runtime
           const imageId   = workbook.addImage({ buffer: fs.readFileSync(absPath) as unknown as ArrayBuffer, extension })
           // screenshot column (0-indexed), row = excelRowIdx - 1 (0-indexed)
           sheet.addImage(imageId, {
             tl:     { col: shotIdx - 1, row: excelRowIdx - 1 },
             ext:    { width: IMG_W, height: IMG_H },
             editAs: 'oneCell',
           })
         } catch {
           withCell('screenshot', (c) => {
             c.value     = absPath
             c.font      = { italic: true, color: { argb: 'FF9CA3AF' } }
             c.alignment = { vertical: 'middle', wrapText: true }
           })
         }
       }

        // Add black borders to all cells in the row
        for (let c = 1; c <= cols.length; c++) {
          const cell = dataRow.getCell(c)
          cell.border = {
            top: { style: 'thin', color: { argb: 'FF000000' } },
            bottom: { style: 'thin', color: { argb: 'FF000000' } },
            left: { style: 'thin', color: { argb: 'FF000000' } },
            right: { style: 'thin', color: { argb: 'FF000000' } },
          }
        }

        dataRow.commit()
      rowNo++
      totalRows++
    }
  }

  // Info sheet
  const meta = workbook.addWorksheet(uniqueSheetName(usedSheetNames, 'Info'))
  meta.addRow(['Laporan AICE WhatsApp Automation'])
  meta.addRow(['Campaign',           campaign.name])
  meta.addRow(['Tipe',               campaign.campaignType])
  meta.addRow(['Bulan',              campaign.bulan])
  meta.addRow(['Dibuat',             new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })])
  meta.addRow(['Total baris',        totalRows])
  meta.addRow(['Total replies valid', totalRows - totalInvalidReplies])
  meta.addRow(['Total replies invalid', totalInvalidReplies])
  meta.getRow(1).font = { bold: true, size: 13 }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

/**
 * Build an XLSX workbook with all campaigns (optionally filtered) — one sheet per campaign.
 * Each campaign sheet contains data organized by area as separate sections.
 *
 * Similar structure to buildCampaignReportXlsx but includes all campaigns.
 */
export async function buildAllCampaignsReportXlsx(filters?: { bulan?: string; campaignType?: string }, options?: ReportXlsxOptions): Promise<Buffer> {
  const campaigns = await db.campaign.findMany({
    where: {
      ...(filters?.bulan && { bulan: filters.bulan }),
      ...(filters?.campaignType && { campaignType: filters.campaignType }),
    },
    include: { areas: { include: { area: { include: { department: true } } } } },
    orderBy: { bulan: 'desc' },
  })

  if (campaigns.length === 0) throw new Error('No campaigns found')

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'AICE WhatsApp Automation'
  workbook.created = new Date()

  let globalTotalRows = 0
  let globalTotalInvalidReplies = 0
  const usedSheetNames = new Set<string>()

  for (const campaign of campaigns) {
    // Campaign names can repeat (or share the same first 31 chars); the helper
    // truncates to Excel's limit and appends _2, _3… on collision.
    const sheetName = uniqueSheetName(usedSheetNames, `${campaign.name}_${campaign.bulan}`)

    const sheet = workbook.addWorksheet(sheetName)

    const cols = resolveColumns(options?.columns, CAMPAIGN_SHEET_COLUMNS)
    const at = (key: ReportColumnKey): number => colIdx(cols, key)

    sheet.columns = cols.map((key) => ({ key, width: REPORT_COLUMN_WIDTHS[key] }))

    // Header row
    const headers = cols.map((key) => REPORT_COLUMN_HEADERS[key])
    const headerRow = sheet.addRow(headers)
    headerRow.height = 22
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10B981' } }
      cell.alignment = { vertical: 'middle', horizontal: 'center' }
      cell.border = { bottom: { style: 'medium', color: { argb: 'FF059669' } } }
    })

    let campaignTotalRows = 0
    let campaignTotalInvalidReplies = 0
    let campaignRowNo = 1

    for (const ca of campaign.areas) {
      const area = ca.area
      const dept = area.department

      const contacts = await db.contact.findMany({
        where: { areaId: area.id, phoneValid: true },
        include: {
          messages: {
            where: { campaignId: campaign.id, status: { in: ['SENT', 'DELIVERED', 'READ'] } },
            include: {
              reply: true,
              agent: { select: { phoneNumber: true } },
            },
            orderBy: { sentAt: 'desc' },
            take: 1,
          },
        },
        orderBy: [{ seqNo: 'asc' }, { storeName: 'asc' }],
      })

      const sentContacts = contacts.filter((c) => c.messages.length > 0)
      if (sentContacts.length === 0) continue

      for (const contact of sentContacts) {
        const message = contact.messages[0]
        const reply = message?.reply
        const agentPhone = message?.agent?.phoneNumber ?? ''
        const hasReply = reply != null
         const jawaban = hasReply ? ((reply?.jawaban ?? 0) as 0 | 1) : null
         const jawabanLabel = jawaban === 1 ? 1 : jawaban === 0 ? 0 : ''
        const kategori = reply?.claudeCategory ?? ''
        const isInvalid = reply?.claudeCategory === 'invalid'
        const statusLabel = isInvalid ? '⚠ Invalid' : (hasReply ? 'Valid' : '')
        const excelRowIdx = campaignRowNo + 1

        if (isInvalid) {
          campaignTotalInvalidReplies++
          globalTotalInvalidReplies++
        }

        const fmtDate = (d: Date | null | undefined) =>
          d ? d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

        const dikirimPada = fmtDate(message?.sentAt)
        const dibalasPada = fmtDate(reply?.receivedAt)
        const rawResponse = reply?.body ?? ''

        const shotIdx = at('screenshot')
        const absPath = reply?.screenshotPath && OUTPUT_FOLDER
          ? path.join(OUTPUT_FOLDER, reply.screenshotPath)
          : null
        const hasImg = shotIdx !== -1 && absPath !== null && fs.existsSync(absPath)
        const embed  = options?.embedImages !== false

        const values: Record<ReportColumnKey, string | number> = {
          no: campaignRowNo, market: '', storeName: contact.storeName, phone: contact.phoneNorm,
          owner: '', dept: dept.name, area: area.name, agentPhone,
          jawaban: jawabanLabel, kategori, status: statusLabel,
          dikirimPada, dibalasPada, rawResponse, screenshot: '',
        }
        const dataRow = sheet.addRow(cols.map((key) => values[key]))
        dataRow.height = hasImg && embed ? ROW_H_WITH_IMG : ROW_H_DEFAULT

        const withCell = (key: ReportColumnKey, fn: (cell: ExcelJS.Cell) => void): void => {
          const idx = at(key)
          if (idx !== -1) fn(dataRow.getCell(idx))
        }

        withCell('no', (c) => { c.alignment = { vertical: 'middle', horizontal: 'center' } })
        withCell('storeName', (c) => { c.alignment = { vertical: 'middle', wrapText: true } })
        withCell('phone', (c) => { c.alignment = { vertical: 'middle' }; c.font = { color: { argb: 'FF6B7280' } } })
        withCell('dept', (c) => { c.alignment = { vertical: 'middle' } })
        withCell('area', (c) => { c.alignment = { vertical: 'middle' } })
        withCell('agentPhone', (c) => { c.alignment = { vertical: 'middle', horizontal: 'center' }; c.font = { color: { argb: 'FF6B7280' } } })

        withCell('jawaban', (jawabanCell) => {
          jawabanCell.alignment = { vertical: 'middle', horizontal: 'center' }
          if (hasReply) {
            jawabanCell.font = { bold: true, color: { argb: jawaban === 1 ? 'FF065F46' : 'FF991B1B' } }
          } else {
            jawabanCell.font = { italic: true, color: { argb: 'FF9CA3AF' } }
            jawabanCell.value = 'Pending'
          }
        })

        const kategoriColors: Record<string, string> = {
          confirmed: 'FF6EE7B7',
          denied:    'FFFCA5A5',
          question:  'FFFDE68A',
          unclear:   'FFE5E7EB',
          invalid:   'FFFBBF24',
          other:     'FFBFDBFE',
        }
        withCell('kategori', (kategoriCell) => {
          kategoriCell.alignment = { vertical: 'middle', horizontal: 'center' }
          if (kategori) {
            kategoriCell.font = { color: { argb: 'FF374151' } }
            kategoriCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: kategoriColors[kategori] ?? 'FFFFFFFF' } }
          }
        })

        withCell('status', (statusCell) => {
          statusCell.alignment = { vertical: 'middle', horizontal: 'center' }
          if (isInvalid) {
            statusCell.font = { bold: true, color: { argb: 'FFDC2626' } }
            statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } }
          } else if (hasReply) {
            statusCell.font = { color: { argb: 'FF059669' } }
            statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } }
          }
        })

        withCell('dikirimPada', (c) => { c.alignment = { vertical: 'middle', horizontal: 'center' }; c.font = { color: { argb: 'FF6B7280' } } })
        withCell('dibalasPada', (c) => { c.alignment = { vertical: 'middle', horizontal: 'center' }; c.font = { color: { argb: 'FF6B7280' } } })
        withCell('rawResponse', (c) => { c.alignment = { vertical: 'middle', wrapText: true }; c.font = { color: { argb: 'FF374151' } } })

        if (campaignRowNo % 2 === 0) {
          for (const key of ['no', 'storeName', 'phone', 'dept', 'area', 'agentPhone'] as const) {
            withCell(key, (cell) => {
              if (!(cell.fill as ExcelJS.FillPattern)?.fgColor) {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAFA' } }
              }
            })
          }
        }

         if (hasImg && !embed) {
           const { archivePath, ref } = buildScreenshotRef(campaign.name, absPath, contact.phoneNorm, contact.storeName)
           options?.onPhoto?.({ archivePath, absPath })
           withCell('screenshot', (c) => {
             c.value = ref
             c.font = { italic: true, color: { argb: 'FF9CA3AF' } }
             c.alignment = { vertical: 'middle', wrapText: true }
           })
         } else if (hasImg) {
           try {
             const ext = path.extname(absPath).toLowerCase().replace('.', '')
             const extension = (ext === 'jpg' ? 'jpeg' : ext) as 'jpeg' | 'png' | 'gif'
             // ExcelJS declares its own Buffer type (extends ArrayBuffer) which clashes with Node Buffer; binary-compatible at runtime
             const imageId = workbook.addImage({ buffer: fs.readFileSync(absPath) as unknown as ArrayBuffer, extension })
             sheet.addImage(imageId, {
               tl: { col: shotIdx - 1, row: excelRowIdx - 1 },
               ext: { width: IMG_W, height: IMG_H },
               editAs: 'oneCell',
             })
             } catch {
              withCell('screenshot', (c) => {
                c.value = absPath
                c.font = { italic: true, color: { argb: 'FF9CA3AF' } }
                c.alignment = { vertical: 'middle', wrapText: true }
              })
            }
          }

        // Add black borders to all cells in the row
        for (let c = 1; c <= cols.length; c++) {
          const cell = dataRow.getCell(c)
          cell.border = {
            top: { style: 'thin', color: { argb: 'FF000000' } },
            bottom: { style: 'thin', color: { argb: 'FF000000' } },
            left: { style: 'thin', color: { argb: 'FF000000' } },
            right: { style: 'thin', color: { argb: 'FF000000' } },
          }
        }

        dataRow.commit()
        campaignRowNo++
        campaignTotalRows++
        globalTotalRows++
      }
    }

    // Add campaign info row at the end of sheet
    if (campaignTotalRows > 0) {
      const infoRow = sheet.addRow([])
      infoRow.height = 2
      const summaryRow = sheet.addRow(cols.map((key) => key === 'no' ? 'Summary:' : ''))
      summaryRow.getCell(1).font = { bold: true }
      sheet.addRow(cols.map((key) => key === 'no' ? 'Total rows:' : key === 'storeName' ? campaignTotalRows : ''))
      sheet.addRow(cols.map((key) => key === 'no' ? 'Valid replies:' : key === 'storeName' ? campaignTotalRows - campaignTotalInvalidReplies : ''))
      sheet.addRow(cols.map((key) => key === 'no' ? 'Invalid replies:' : key === 'storeName' ? campaignTotalInvalidReplies : ''))
    }
  }

  // Summary sheet
  const summary = workbook.addWorksheet(uniqueSheetName(usedSheetNames, 'Summary'), { state: 'visible' })
  summary.addRow(['Laporan AICE WhatsApp Automation — All Campaigns'])
  summary.addRow([''])
  summary.addRow(['Generated', new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })])
  summary.addRow(['Total campaigns', campaigns.length])
  summary.addRow(['Total rows', globalTotalRows])
  summary.addRow(['Valid replies', globalTotalRows - globalTotalInvalidReplies])
  summary.addRow(['Invalid replies', globalTotalInvalidReplies])
  summary.addRow([''])
  summary.addRow(['Campaign List:'])
  campaigns.forEach((c) => {
    summary.addRow([`${c.bulan} - ${c.campaignType} - ${c.name}`])
  })
  summary.getRow(1).font = { bold: true, size: 13 }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

/**
 * Filter options for buildDepartmentReportXlsx
 */
interface DepartmentReportFilters {
  bulan?: string
  campaignType?: string
  categories?: string[] // claude categories to include
  jawabans?: (0 | 1 | null)[] // jawaban values (0, 1, null=Tidak Jelas)
}

/**
 * Build an XLSX workbook organized by Department with Campaigns inside each sheet.
 * Supports comprehensive filtering by category and jawaban.
 *
 * Structure:
 * - One sheet per department (alphabetically ordered)
 * - Multiple campaigns per sheet (with empty row separator)
 * - Column order: Market | No | Nama Toko | No HP | Agent Phone | Dynamic Jawaban Header | Kategori | Status | etc.
 */
export async function buildDepartmentReportXlsx(filters?: DepartmentReportFilters, options?: ReportXlsxOptions): Promise<Buffer> {
  const campaignFilters: Record<string, unknown> = {
    ...(filters?.bulan && { bulan: filters?.bulan }),
    ...(filters?.campaignType && { campaignType: filters?.campaignType }),
  }

  // Fetch all departments with their campaigns and data
  const departments = await db.department.findMany({
    include: {
      areas: {
        include: {
          contacts: {
            where: { phoneValid: true },
            include: {
              messages: {
                where: {
                  campaign: campaignFilters,
                  status: { in: ['SENT', 'DELIVERED', 'READ'] },
                },
                include: {
                   reply: true,
                   agent: { select: { phoneNumber: true } },
                   campaign: { select: { id: true, name: true, bulan: true, campaignType: true, template: true } },
                 },
                orderBy: { sentAt: 'desc' },
                take: 1,
              },
            },
            orderBy: [{ seqNo: 'asc' }, { storeName: 'asc' }],
          },
        },
      },
    },
    orderBy: { name: 'asc' },
  })

  // Group messages by campaign
  type CampaignRowData = {
    contact: (typeof departments)[number]['areas'][number]['contacts'][number]
    area: (typeof departments)[number]['areas'][number]
    message: (typeof departments)[number]['areas'][number]['contacts'][number]['messages'][number]
    reply: (typeof departments)[number]['areas'][number]['contacts'][number]['messages'][number]['reply']
    hasReply: boolean
    jawaban: 0 | 1 | null
    jawabanLabel: 0 | 1 | ''
  }
  
  type CampaignDataMap = {
    campaign: (typeof departments)[number]['areas'][number]['contacts'][number]['messages'][number]['campaign']
    rows: CampaignRowData[]
  }
  
  const campaignsByDept = new Map<string, Map<string, CampaignDataMap>>()

  for (const dept of departments) {
    const campaignMap = new Map<string, CampaignDataMap>()

    for (const area of dept.areas) {
      for (const contact of area.contacts) {
        const msg = contact.messages[0]
        if (!msg) continue

        const campaign = msg.campaign
        const reply = msg.reply
        const hasReply = reply != null

        // Apply filters
        const categoryMatches = !filters?.categories || filters.categories.includes(reply?.claudeCategory || '')
        const jawabanValue = (reply?.jawaban ?? null) as 0 | 1 | null
        const jawabanMatches = !filters?.jawabans || filters.jawabans.includes(jawabanValue)

        if (!categoryMatches || !jawabanMatches) continue

        // Add to campaign map
        const campaignKey = campaign.id
        if (!campaignMap.has(campaignKey)) {
          campaignMap.set(campaignKey, { campaign, rows: [] })
        }

        const jawaban = hasReply ? ((reply?.jawaban ?? 0) as 0 | 1) : null
        const jawabanLabel = jawaban === 1 ? 1 : jawaban === 0 ? 0 : ''

        campaignMap.get(campaignKey)?.rows.push({
          contact,
          area,
          message: msg,
          reply,
          hasReply,
          jawaban,
          jawabanLabel,
        })
      }
    }

    if (campaignMap.size > 0) {
      campaignsByDept.set(dept.id, campaignMap)
    }
  }

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'AICE WhatsApp Automation'
  workbook.created = new Date()

  let globalTotalRows = 0
  let globalTotalInvalidReplies = 0
  const summaryData: { dept: string; campaigns: number; totalRows: number; validRows: number; invalidRows: number }[] = []
  const usedSheetNames = new Set<string>()

  // Create sheets per department
  for (const dept of departments) {
    const campaignMap = campaignsByDept.get(dept.id)
    if (!campaignMap) continue

    const sheetName = uniqueSheetName(usedSheetNames, dept.name)
    const sheet = workbook.addWorksheet(sheetName)

    const cols = resolveColumns(options?.columns, DEPT_SHEET_COLUMNS)
    const at = (key: ReportColumnKey): number => colIdx(cols, key)

    sheet.columns = cols.map((key) => ({
      key,
      width: key === 'jawaban' ? 40 : REPORT_COLUMN_WIDTHS[key],
    }))

    let deptTotalRows = 0
    let deptTotalInvalidReplies = 0
    let isFirstCampaign = true

    // Sort campaigns alphabetically
    const sortedCampaigns = Array.from(campaignMap.entries()).sort((a, b) => {
      const campaignA = a[1].campaign
      const campaignB = b[1].campaign
      return campaignA.name.localeCompare(campaignB.name)
    })

    for (const [, { campaign, rows }] of sortedCampaigns) {
      if (rows.length === 0) continue

      // Add empty row between campaigns (except before first)
      if (!isFirstCampaign) {
        sheet.addRow([])
      }
      isFirstCampaign = false

      // Header row with dynamic jawaban column name
      const headers = cols.map((key) => {
        if (key === 'jawaban') return `${campaign.template.replaceAll('{{bulan}}', campaign.bulan)} (ya=1, tidak=0)`
        if (key === 'phone') return 'No HP'
        return REPORT_COLUMN_HEADERS[key]
      })
      const headerRow = sheet.addRow(headers)
      headerRow.height = 102
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10B981' } }
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
        cell.border = {
          top: { style: 'thin', color: { argb: 'FF000000' } },
          bottom: { style: 'thin', color: { argb: 'FF000000' } },
          left: { style: 'thin', color: { argb: 'FF000000' } },
          right: { style: 'thin', color: { argb: 'FF000000' } },
        }
      })

      let campaignRowNo = 1
      let campaignInvalidCount = 0
      let sheetRowIndex = sheet.rowCount + 1 // Track current sheet row
      let firstDataRowNum = 0 // Track first data row number for formula

      for (const rowData of rows) {
        const { contact, area, message, reply, hasReply, jawabanLabel } = rowData
        const isInvalid = reply?.claudeCategory === 'invalid'

        if (isInvalid) {
          campaignInvalidCount++
          globalTotalInvalidReplies++
        }

        const fmtDate = (d: Date | null | undefined) =>
          d ? d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

        const dikirimPada = fmtDate(message?.sentAt)
        const dibalasPada = fmtDate(reply?.receivedAt)
        const rawResponse = reply?.body ?? ''

        const shotIdx = at('screenshot')
        const absPath = reply?.screenshotPath && OUTPUT_FOLDER
          ? path.join(OUTPUT_FOLDER, reply.screenshotPath)
          : null
        const hasImg = shotIdx !== -1 && absPath !== null && fs.existsSync(absPath)
        const embed  = options?.embedImages !== false

        const values: Record<ReportColumnKey, string | number> = {
          no: campaignRowNo, market: area.name, storeName: contact.storeName,
          phone: contact.phoneNorm.replaceAll('+', ''), owner: contact.storeName,
          dept: '', area: area.name, agentPhone: message?.agent?.phoneNumber ?? '',
          jawaban: jawabanLabel, kategori: reply?.claudeCategory ?? '',
          status: !hasReply ? '' : (isInvalid ? '⚠ Invalid' : 'Valid'),
          dikirimPada, dibalasPada, rawResponse, screenshot: '',
        }
        const dataRow = sheet.addRow(cols.map((key) => values[key]))

        const withCell = (key: ReportColumnKey, fn: (cell: ExcelJS.Cell) => void): void => {
          const idx = at(key)
          if (idx !== -1) fn(dataRow.getCell(idx))
        }
        
        // Save first data row number for formula calculation
        if (firstDataRowNum === 0) {
          firstDataRowNum = dataRow.number
        }
        
        dataRow.height = hasImg && embed ? ROW_H_WITH_IMG : ROW_H_DEFAULT

        const borderStyle = {
          top: { style: 'thin' as const, color: { argb: 'FF000000' } },
          bottom: { style: 'thin' as const, color: { argb: 'FF000000' } },
          left: { style: 'thin' as const, color: { argb: 'FF000000' } },
          right: { style: 'thin' as const, color: { argb: 'FF000000' } },
        }

        withCell('no', (c) => { c.alignment = { vertical: 'middle' }; c.border = borderStyle })
        withCell('market', (c) => { c.alignment = { vertical: 'middle', horizontal: 'center' }; c.border = borderStyle })
        withCell('storeName', (c) => { c.alignment = { vertical: 'middle', wrapText: true }; c.border = borderStyle })
        withCell('phone', (c) => { c.alignment = { vertical: 'middle' }; c.font = { color: { argb: 'FF000000' } }; c.border = borderStyle })
        withCell('owner', (c) => { c.alignment = { vertical: 'middle', wrapText: true }; c.border = borderStyle })
        withCell('agentPhone', (c) => { c.alignment = { vertical: 'middle', horizontal: 'center' }; c.font = { color: { argb: 'FF6B7280' } }; c.border = borderStyle })

        // Jawaban cell
        withCell('jawaban', (jawabanCell) => {
          jawabanCell.alignment = { vertical: 'middle', horizontal: 'center' }
          jawabanCell.border = borderStyle
          if (hasReply) {
            jawabanCell.font = { bold: true, color: { argb: 'FF000000' } }
          } else {
            jawabanCell.font = { italic: true, color: { argb: 'FF9CA3AF' } }
            jawabanCell.value = 'Pending'
          }
        })

        // Kategori cell (col 8)
        const kategoriColors: Record<string, string> = {
          confirmed: 'FF6EE7B7',
          denied: 'FFFCA5A5',
          question: 'FFFDE68A',
          unclear: 'FFE5E7EB',
          invalid: 'FFFBBF24',
          other: 'FFBFDBFE',
        }
        withCell('kategori', (kategoriCell) => {
          kategoriCell.alignment = { vertical: 'middle', horizontal: 'center' }
          kategoriCell.border = borderStyle
          if (reply?.claudeCategory) {
            kategoriCell.font = { color: { argb: 'FF374151' } }
            kategoriCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: kategoriColors[reply.claudeCategory] ?? 'FFFFFFFF' } }
          }
        })

        // Status cell
        withCell('status', (statusCell) => {
          statusCell.alignment = { vertical: 'middle', horizontal: 'center' }
          statusCell.border = borderStyle
          if (isInvalid) {
            statusCell.font = { bold: true, color: { argb: 'FFDC2626' } }
            statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } }
          } else if (hasReply) {
            statusCell.font = { color: { argb: 'FF059669' } }
            statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } }
          }
        })

        withCell('dikirimPada', (c) => { c.alignment = { vertical: 'middle', horizontal: 'center' }; c.font = { color: { argb: 'FF6B7280' } }; c.border = borderStyle })
        withCell('dibalasPada', (c) => { c.alignment = { vertical: 'middle', horizontal: 'center' }; c.font = { color: { argb: 'FF6B7280' } }; c.border = borderStyle })
        withCell('rawResponse', (c) => { c.alignment = { vertical: 'middle', wrapText: true }; c.font = { color: { argb: 'FF374151' } }; c.border = borderStyle })
        withCell('screenshot', (c) => { c.border = borderStyle })

         if (hasImg && !embed) {
           const { archivePath, ref } = buildScreenshotRef(campaign.name, absPath, contact.phoneNorm, contact.storeName)
           options?.onPhoto?.({ archivePath, absPath })
           withCell('screenshot', (c) => {
             c.value = ref
             c.font = { italic: true, color: { argb: 'FF9CA3AF' } }
             c.alignment = { vertical: 'middle', wrapText: true }
           })
         } else if (hasImg) {
           try {
             const ext = path.extname(absPath).toLowerCase().replace('.', '')
             const extension = (ext === 'jpg' ? 'jpeg' : ext) as 'jpeg' | 'png' | 'gif'
             // ExcelJS declares its own Buffer type (extends ArrayBuffer) which clashes with Node Buffer; binary-compatible at runtime
              const imageId = workbook.addImage({ buffer: fs.readFileSync(absPath) as unknown as ArrayBuffer, extension })
              sheet.addImage(imageId, {
                tl: { col: shotIdx - 1, row: sheetRowIndex - 1 },
                ext: { width: IMG_W, height: IMG_H },
                editAs: 'oneCell',
              })
            } catch {
              withCell('screenshot', (c) => {
                c.value = absPath
                c.font = { italic: true, color: { argb: 'FF9CA3AF' } }
                c.alignment = { vertical: 'middle', wrapText: true }
              })
           }
         }

        dataRow.commit()
        campaignRowNo++
        deptTotalRows++
        globalTotalRows++
        sheetRowIndex++ // Increment row index
      }

      // Add Pencapaian (Achievement) summary row after each campaign table.
      // Needs the Jawaban column for its COUNTIF formula — skip when excluded.
      const jawabanIdx = at('jawaban')
      if (jawabanIdx !== -1) {
        const lastDataRowNum = sheet.rowCount
        const pencapaianRow = sheet.addRow(cols.map((key) => key === 'no' ? 'Pencapaian' : ''))
        pencapaianRow.height = 20

        // Set the formula in the Jawaban column (dynamic letter, e.g. G)
        const colLetter = String.fromCharCode(64 + jawabanIdx)
        const range = `${colLetter}${firstDataRowNum}:${colLetter}${lastDataRowNum}`
        const formulaCell = pencapaianRow.getCell(jawabanIdx)
        formulaCell.value = { formula: `COUNTIF(${range},1)/(COUNTIF(${range},1)+COUNTIF(${range},0))` }
        formulaCell.font = { bold: true, size: 11, color: { argb: 'FF10B981' } }
        formulaCell.alignment = { vertical: 'middle', horizontal: 'center' }
        formulaCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } }
        formulaCell.numFmt = '0%'

        // Merge label across the first columns (up to E)
        if (cols.length > 1) {
          const mergeEnd = String.fromCharCode(64 + Math.min(5, cols.length))
          sheet.mergeCells(`A${pencapaianRow.number}:${mergeEnd}${pencapaianRow.number}`)
        }

        // Style the Pencapaian row
        pencapaianRow.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF10B981' } }
        pencapaianRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' }

        // Add black borders to all cells in Pencapaian row
        for (let c = 1; c <= cols.length; c++) {
          const cell = pencapaianRow.getCell(c)
          cell.border = {
            top: { style: 'thin', color: { argb: 'FF000000' } },
            bottom: { style: 'thin', color: { argb: 'FF000000' } },
            left: { style: 'thin', color: { argb: 'FF000000' } },
            right: { style: 'thin', color: { argb: 'FF000000' } },
          }
        }
      }

      deptTotalInvalidReplies += campaignInvalidCount
    }

    summaryData.push({
      dept: dept.name,
      campaigns: campaignMap.size,
      totalRows: deptTotalRows,
      validRows: deptTotalRows - deptTotalInvalidReplies,
      invalidRows: deptTotalInvalidReplies,
    })
  }

  // Summary sheet
  const summary = workbook.addWorksheet(uniqueSheetName(usedSheetNames, 'Summary'), { state: 'visible' })
  summary.addRow(['Laporan AICE WhatsApp Automation — By Department'])
  summary.addRow([''])
  summary.addRow(['Generated', new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })])
  summary.addRow(['Total departments', summaryData.length])
  summary.addRow(['Total rows', globalTotalRows])
  summary.addRow(['Valid replies', globalTotalRows - globalTotalInvalidReplies])
  summary.addRow(['Invalid replies', globalTotalInvalidReplies])
  summary.addRow([''])
  summary.addRow(['Department Summary:'])

  const headerRow = summary.addRow(['Department', 'Campaigns', 'Total Rows', 'Valid', 'Invalid'])
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10B981' } }
  })

  summaryData.forEach((d) => {
    summary.addRow([d.dept, d.campaigns, d.totalRows, d.validRows, d.invalidRows])
  })

  summary.getRow(1).font = { bold: true, size: 13 }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}
