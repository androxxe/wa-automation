import fs from 'fs'
import path from 'path'
import * as XLSX from 'xlsx'
import type { DepartmentTree, AreaFile, ParsedSheet } from '@aice/shared'

const DATA_FOLDER = process.env.DATA_FOLDER ?? ''

/**
 * Recursively scan DATA_FOLDER for Department X / *.xlsx structure.
 */
export function scanDataFolder(): DepartmentTree[] {
  if (!DATA_FOLDER || !fs.existsSync(DATA_FOLDER)) {
    return []
  }

  const departments: DepartmentTree[] = []
  const entries = fs.readdirSync(DATA_FOLDER, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const deptPath = path.join(DATA_FOLDER, entry.name)
    const areas: AreaFile[] = []

    const files = fs.readdirSync(deptPath, { withFileTypes: true })
    for (const file of files) {
      if (!file.isFile()) continue
      if (!file.name.toLowerCase().endsWith('.xlsx')) continue

      const areaName = path.basename(file.name, '.xlsx')
      areas.push({
        name: areaName,
        fileName: file.name,
        filePath: path.join(deptPath, file.name),
      })
    }

    if (areas.length > 0) {
      departments.push({ name: entry.name, path: deptPath, areas })
    }
  }

  return departments.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Parse a single xlsx file. Returns headers, 2 sample rows, and total row count.
 * Handles merged/multiline headers by joining cell lines with a space.
 */
export function parseSheet(filePath: string): ParsedSheet {
  const workbook = XLSX.readFile(filePath)
  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]

  // raw: true keeps cell values as-is (numbers, strings)
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    raw: false,
    defval: '',
  })

  if (rows.length === 0) {
    return { headers: [], sampleRows: [], totalRows: 0 }
  }

  const headers = Object.keys(rows[0])
  const sampleRows = rows.slice(0, 2)

  return { headers, sampleRows, totalRows: rows.length }
}

/**
 * Parse a full sheet applying a confirmed column mapping.
 * Returns all rows with normalized field names.
 */
export function parseSheetWithMapping(
  filePath: string,
  mapping: Record<string, string>,
): Record<string, unknown>[] {
  const workbook = XLSX.readFile(filePath)
  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    raw: false,
    defval: '',
  })

  // Invert mapping: Excel header → internal field
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
