import * as XLSX from 'xlsx'
import { db } from './db'
import { uploadBuffer } from './minio'

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
 * Write per-department/area xlsx files to MinIO.
 */
export async function writeOutputFiles(): Promise<void> {
  const today  = new Date().toISOString().slice(0, 10)
  const key    = `reports/xlsx/responses_${today}.xlsx`
  const buffer = await buildResponseWorkbook({})
  await uploadBuffer(key, buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  console.log(`[exporter] uploaded → minio:${key}`)
}
