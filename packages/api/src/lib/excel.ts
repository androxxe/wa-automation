import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import type { ContactTypeTree, DepartmentTree, AreaFile, ParsedSheet, ContactType } from '@aice/shared'
import { CONTACT_TYPES } from '@aice/shared'

const DATA_FOLDER = process.env.DATA_FOLDER ?? ''

const VALID_TYPES: readonly ContactType[] = CONTACT_TYPES

/**
 * Scan DATA_FOLDER with 3-level structure: Type → Department → Area.xlsx
 *
 * Expected layout:
 *   DATA_FOLDER/
 *     STIK/
 *       Department 1/
 *         Aceh Barat.xlsx
 *     KARDUS/
 *       Department 1/
 *         Aceh Barat.xlsx
 *
 * Falls back to the old 2-level layout (Department/Area.xlsx) if no type
 * subfolders are found, treating everything as "STIK".
 */
export function scanDataFolder(): ContactTypeTree[] {
  if (!DATA_FOLDER || !fs.existsSync(DATA_FOLDER)) return []

  const topEntries = fs.readdirSync(DATA_FOLDER, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))

  // Detect new 3-level layout: top-level entries are STIK / KARDUS
  const typeEntries = topEntries.filter((e) =>
    VALID_TYPES.includes(e.name.toUpperCase() as ContactType),
  )

  if (typeEntries.length > 0) {
    // New layout
    return typeEntries
      .map((typeEntry) => {
        const contactType = typeEntry.name.toUpperCase() as ContactType
        const typePath    = path.join(DATA_FOLDER, typeEntry.name)
        return {
          contactType,
          departments: scanDepartments(typePath, contactType),
        }
      })
      .filter((t) => t.departments.length > 0)
  }

  // Legacy 2-level layout — treat everything as STIK
  return [
    {
      contactType: 'STIK' as ContactType,
      departments: scanDepartments(DATA_FOLDER, 'STIK'),
    },
  ].filter((t) => t.departments.length > 0)
}

function scanDepartments(basePath: string, contactType: ContactType): DepartmentTree[] {
  const entries = fs.readdirSync(basePath, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))

  const departments: DepartmentTree[] = []

  for (const entry of entries) {
    const deptPath = path.join(basePath, entry.name)
    const areas    = scanAreas(deptPath, contactType)
    if (areas.length > 0) {
      departments.push({ name: entry.name, path: deptPath, areas })
    }
  }

  return departments.sort((a, b) => a.name.localeCompare(b.name))
}

function scanAreas(deptPath: string, contactType: ContactType): AreaFile[] {
  return fs.readdirSync(deptPath, { withFileTypes: true })
    .filter((f) => {
      if (!f.isFile()) return false
      if (!f.name.toLowerCase().endsWith('.xlsx')) return false
      if (f.name.startsWith('.') || f.name.startsWith('~$') || f.name.startsWith('.~')) return false
      return true
    })
    .map((f) => ({
      name:        path.basename(f.name, '.xlsx'),
      fileName:    f.name,
      filePath:    path.join(deptPath, f.name),
      contactType,
    }))
}

// ─── Header-row detection ─────────────────────────────────────────────────────

// AICE source templates carry title/instruction blocks above the real table.
// The SheetJS default (first row = header) then turns the real header row into
// data — importing cells like "终端联系电话 No telp" as phone numbers. Scan the
// first rows and use the one that looks most like a header row instead.

const HEADER_SCAN_LIMIT = 20
const HEADER_MIN_HITS = 2
const HEADER_MAX_CELL_LEN = 120

const HEADER_KEYWORDS = [
  'nama toko', '店名', '终端', 'no telp', 'no. telp', 'nomor telepon',
  'no hp', 'no. hp', 'telepon', 'phone', 'whatsapp',
  '序号', 'wilayah', 'provinsi', 'kota', 'kabupaten', 'kecamatan',
  '经销商', '冰柜', 'freezer', 'frezer', 'merk', 'merek',
  'alamat', 'address', 'keterangan', 'jumlah', 'agen', 'outlet',
  'store', 'kode', 'tanggal',
]

function headerScore(row: unknown[]): number {
  let hits = 0
  for (const cell of row) {
    const s = String(cell ?? '').trim().toLowerCase()
    if (!s || s.length > HEADER_MAX_CELL_LEN) continue
    if (HEADER_KEYWORDS.some((k) => s.includes(k))) hits++
  }
  return hits
}

/**
 * Returns the absolute sheet row index of the detected header row, or null when
 * no row in the first HEADER_SCAN_LIMIT rows looks like a header (caller then
 * falls back to the SheetJS default).
 */
function detectHeaderRow(sheet: XLSX.WorkSheet): number | null {
  const ref = sheet['!ref']
  const startRow = ref ? XLSX.utils.decode_range(ref).s.r : 0
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '' })

  let best = 0
  let bestScore = -1
  const limit = Math.min(raw.length, HEADER_SCAN_LIMIT)
  for (let i = 0; i < limit; i++) {
    const score = headerScore(raw[i] ?? [])
    if (score > bestScore) { bestScore = score; best = i }
  }
  return bestScore >= HEADER_MIN_HITS ? startRow + best : null
}

function sheetToRows(sheet: XLSX.WorkSheet): Record<string, unknown>[] {
  const headerRow = detectHeaderRow(sheet)
  if (headerRow !== null) {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      raw:    false,
      defval: '',
      range:  headerRow,
    })
    // Guard against index drift (e.g. leading empty rows) — if the parsed keys
    // don't look like headers, fall back to the SheetJS default.
    const probe = Object.keys(rows[0] ?? {})
    if (probe.length > 0 && headerScore(probe) >= HEADER_MIN_HITS) return rows
  }
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    raw:    false,
    defval: '',
  })
}

/**
 * Parse a single xlsx file. Returns headers, 5 sample rows, and total row count.
 * Tries to find the most relevant sheet: prefers "Sheet1" if it exists,
 * otherwise selects the sheet with the most data that isn't empty.
 */
export function parseSheet(filePath: string): ParsedSheet {
  const workbook = XLSX.readFile(filePath)
  
  // Try to find Sheet1 first, as it often contains the actual data
  let sheetName = workbook.SheetNames[0]
  if (workbook.SheetNames.includes('Sheet1')) {
    sheetName = 'Sheet1'
  }
  
  const sheet = workbook.Sheets[sheetName]
  const rows  = sheetToRows(sheet)

  if (rows.length === 0) return { headers: [], sampleRows: [], totalRows: 0 }

  return {
    headers:    Object.keys(rows[0]),
    sampleRows: rows.slice(0, 5),
    totalRows:  rows.length,
  }
}

/**
 * Parse a full sheet applying a confirmed column mapping.
 * Prefers "Sheet1" if it exists, otherwise uses the first sheet.
 */
export function parseSheetWithMapping(
  filePath: string,
  mapping: Record<string, string>,
): Record<string, unknown>[] {
  const workbook = XLSX.readFile(filePath)
  
  // Try to find Sheet1 first, as it often contains the actual data
  let sheetName = workbook.SheetNames[0]
  if (workbook.SheetNames.includes('Sheet1')) {
    sheetName = 'Sheet1'
  }
  
  const sheet = workbook.Sheets[sheetName]
  const rows  = sheetToRows(sheet)

  const inverted: Record<string, string> = {}
  for (const [field, header] of Object.entries(mapping)) {
    if (header) inverted[header] = field
  }

  return rows.map((row) => {
    const mapped: Record<string, unknown> = {}
    for (const [header, value] of Object.entries(row)) {
      const field = inverted[header]
      if (field) mapped[field] = value
    }
    return mapped
  })
}
