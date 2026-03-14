import fs from 'fs'
import path from 'path'
import * as XLSX from 'xlsx'
import { db } from './db'

const OUTPUT_FOLDER = process.env.OUTPUT_FOLDER ?? ''

interface ResponseRow {
  No: string
  'Nama Toko': string
  'No HP': string
  'Pesan Dikirim': string
  Status: string
  'Waktu Kirim': string
  Balasan: string
  Kategori: string
  Sentimen: string
  Ringkasan: string
  'Waktu Balas': string
}

/**
 * Export responses for a given date range (optional) to an xlsx buffer.
 */
export async function buildResponseWorkbook(filters: {
  startDate?: string
  endDate?: string
  departmentId?: string
  areaId?: string
}): Promise<Buffer> {
  const messages = await db.message.findMany({
    where: {
      status: { in: ['SENT', 'DELIVERED', 'READ'] },
      ...(filters.startDate && {
        sentAt: { gte: new Date(filters.startDate) },
      }),
      ...(filters.endDate && {
        sentAt: { lte: new Date(filters.endDate + 'T23:59:59Z') },
      }),
      contact: {
        ...(filters.departmentId && { departmentId: filters.departmentId }),
        ...(filters.areaId && { areaId: filters.areaId }),
      },
    },
    include: {
      contact: true,
      reply: true,
    },
    orderBy: { sentAt: 'asc' },
  })

  const rows: ResponseRow[] = messages.map((m) => ({
    No: m.contact.seqNo ?? '',
    'Nama Toko': m.contact.storeName,
    'No HP': m.contact.phoneNorm,
    'Pesan Dikirim': m.body,
    Status: m.status,
    'Waktu Kirim': m.sentAt?.toISOString() ?? '',
    Balasan: m.reply?.body ?? '',
    Kategori: m.reply?.claudeCategory ?? '',
    Sentimen: m.reply?.claudeSentiment ?? '',
    Ringkasan: m.reply?.claudeSummary ?? '',
    'Waktu Balas': m.reply?.receivedAt?.toISOString() ?? '',
  }))

  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Responses')

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

/**
 * Write per-department/area xlsx files to OUTPUT_FOLDER.
 */
export async function writeOutputFiles(): Promise<void> {
  if (!OUTPUT_FOLDER) throw new Error('OUTPUT_FOLDER is not set')

  const today = new Date().toISOString().slice(0, 10)
  const dailyPath = path.join(OUTPUT_FOLDER, `responses_${today}.xlsx`)

  const buffer = await buildResponseWorkbook({})
  fs.mkdirSync(OUTPUT_FOLDER, { recursive: true })
  fs.writeFileSync(dailyPath, buffer)

  // TODO: also write per-department files
}
