import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { db } from './db'

const OUTPUT_FOLDER = process.env.OUTPUT_FOLDER ?? ''

export type ResponseColumnKey =
  | 'no' | 'storeName' | 'phone' | 'body' | 'status' | 'sentAt'
  | 'reply' | 'kategori' | 'sentimen' | 'ringkasan' | 'repliedAt'

const RESPONSE_COLUMN_LABELS: Record<ResponseColumnKey, string> = {
  no: 'No', storeName: 'Nama Toko', phone: 'No HP', body: 'Pesan Dikirim',
  status: 'Status', sentAt: 'Waktu Kirim', reply: 'Balasan', kategori: 'Kategori',
  sentimen: 'Sentimen', ringkasan: 'Ringkasan', repliedAt: 'Waktu Balas',
}

const RESPONSE_COLUMN_ORDER: ResponseColumnKey[] = [
  'no', 'storeName', 'phone', 'body', 'status', 'sentAt',
  'reply', 'kategori', 'sentimen', 'ringkasan', 'repliedAt',
]

function resolveResponseColumns(requested: string[] | undefined): string[] {
  if (!requested) return RESPONSE_COLUMN_ORDER.map((k) => RESPONSE_COLUMN_LABELS[k])
  const want = new Set(requested.map((c) => c.trim()).filter(Boolean))
  const labels = RESPONSE_COLUMN_ORDER.filter((k) => want.has(k)).map((k) => RESPONSE_COLUMN_LABELS[k])
  if (labels.length === 0) throw new Error('No valid columns selected')
  return labels
}

/**
 * Export responses for a given date range (optional) to an xlsx buffer.
 */
export async function buildResponseWorkbook(filters: {
  startDate?: string
  endDate?: string
  departmentId?: string
  areaId?: string
  columns?: string[]
}): Promise<Buffer> {
  const messages = await db.message.findMany({
    where: {
      status: { in: ['SENT', 'DELIVERED', 'READ'] },
      ...(filters.startDate && {
        sentAt: { gte: new Date(filters.startDate) },
      }),
      ...(filters.endDate && {
        sentAt: { lte: new Date(`${filters.endDate}T23:59:59Z`) },
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

  const labels = resolveResponseColumns(filters.columns)
  const rows: Array<Record<string, string>> = messages.map((m) => {
    const full: Record<string, string> = {
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
    }
    return Object.fromEntries(labels.map((l) => [l, full[l] ?? '']))
  })

  const ws = XLSX.utils.json_to_sheet(rows, { header: labels })
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
