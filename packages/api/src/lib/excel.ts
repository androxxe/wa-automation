import fs from 'fs'
import path from 'path'
import * as XLSX from 'xlsx'
import type { ContactTypeTree, DepartmentTree, AreaFile, ParsedSheet, ContactType } from '@aice/shared'

const DATA_FOLDER = process.env.DATA_FOLDER ?? ''

const VALID_TYPES: ContactType[] = ['STIK', 'KARDUS']

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
  
  const sheet    = workbook.Sheets[sheetName]
  const rows     = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    raw:    false,
    defval: '',
  })

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
  
  const sheet    = workbook.Sheets[sheetName]
  const rows     = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    raw:    false,
    defval: '',
  })

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
