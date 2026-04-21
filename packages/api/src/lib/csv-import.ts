import fs from 'fs'
import { createReadStream } from 'fs'
import path from 'path'
import { Readable } from 'stream'
import dotenv from 'dotenv'
import { PrismaClient } from '@prisma/client'

// Load environment variables - go up 4 levels from lib/ to project root
const projectRoot = path.resolve(__dirname, '../../../..')
const envProdPath = path.join(projectRoot, '.env.prod')
const envDevPath = path.join(projectRoot, '.env.dev')

if (fs.existsSync(envProdPath)) {
  dotenv.config({ path: envProdPath })
} else if (fs.existsSync(envDevPath)) {
  dotenv.config({ path: envDevPath })
} else {
  throw new Error('No .env file found in project root')
}

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
})

import { normalizePhone } from './phone'

interface CSVRow {
  nama: string
  phone: string
  area: string
  department: string
}

interface ImportStats {
  imported: number
  invalid: number
  duplicates: number
  total: number
  details: {
    invalidRows: Array<{ row: number; reason: string }>
  }
}

interface DeptResult {
  id: string
  name: string
}

interface AreaResult {
  id: string
  name: string
}

/**
 * Parse CSV file and return rows with basic validation
 */
export async function parseCSV(filePath: string): Promise<CSVRow[]> {
  const rows: CSVRow[] = []
  let lineNumber = 0

  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: 'utf-8' })
    let buffer = ''

    stream.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines[lines.length - 1] // Keep incomplete line in buffer

      for (let i = 0; i < lines.length - 1; i++) {
        lineNumber++
        if (lineNumber === 1) continue // Skip header

        const line = lines[i].trim()
        if (!line) continue

        const [nama, phone, area, department] = parseCSVLine(line)

        if (nama && phone && area && department) {
          rows.push({ nama: nama.trim(), phone: phone.trim(), area: area.trim(), department: department.trim() })
        }
      }
    })

    stream.on('end', () => {
      // Process last line
      if (buffer.trim()) {
        lineNumber++
        const [nama, phone, area, department] = parseCSVLine(buffer)
        if (nama && phone && area && department) {
          rows.push({ nama: nama.trim(), phone: phone.trim(), area: area.trim(), department: department.trim() })
        }
      }
      resolve(rows)
    })

    stream.on('error', reject)
  })
}

/**
 * Parse a single CSV line, handling quoted fields
 */
function parseCSVLine(line: string): [string, string, string, string] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === ',' && !inQuotes) {
      fields.push(current)
      current = ''
    } else {
      current += char
    }
  }
  fields.push(current)

  // Clean up quoted fields
  return fields.map((f) => f.replace(/^"(.*)"$/, '$1')) as [string, string, string, string]
}

/**
 * Import CSV data to database
 * Returns import statistics
 */
export async function importCSV(filePath: string): Promise<ImportStats> {
  try {
    // Parse CSV
    console.log(`📖 Parsing CSV file: ${filePath}`)
    const rows = await parseCSV(filePath)
    console.log(`✅ Parsed ${rows.length} records\n`)

    const stats: ImportStats = {
      imported: 0,
      invalid: 0,
      duplicates: 0,
      total: rows.length,
      details: {
        invalidRows: [],
      },
    }

    // Group by department and area to optimize lookups
    const departmentMap = new Map<string, DeptResult>()
    const areaMap = new Map<string, AreaResult>()

    console.log('🔄 Processing records...\n')

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const rowNum = i + 2 // +2 because line 1 is header, array is 0-indexed

      try {
        // Get or create department
        let dept = departmentMap.get(row.department)
        if (!dept) {
          const foundDept = await prisma.department.findUnique({
            where: { name: row.department },
            select: { id: true, name: true },
          })

          if (foundDept) {
            dept = foundDept as DeptResult
          } else {
            const newDept = await prisma.department.create({
              data: {
                name: row.department,
                path: `KARDUS/${row.department}`,
              },
              select: { id: true, name: true },
            })
            dept = newDept as DeptResult
            console.log(`  📁 Created Department: ${row.department}`)
          }
          departmentMap.set(row.department, dept)
        }

        // Get or create area
        const areaKey = `${dept.id}|${row.area}`
        let area = areaMap.get(areaKey)
        if (!area) {
          const foundArea = await prisma.area.findUnique({
            where: {
              departmentId_name_contactType: {
                departmentId: dept.id,
                name: row.area,
                contactType: 'KARDUS',
              },
            },
            select: { id: true, name: true },
          })

          if (foundArea) {
            area = foundArea as AreaResult
          } else {
            const newArea = await prisma.area.create({
              data: {
                name: row.area,
                contactType: 'KARDUS',
                fileName: `${row.area}.csv`,
                filePath: `KARDUS/${row.department}/${row.area}.csv`,
                columnMapping: {},
                departmentId: dept.id,
              },
              select: { id: true, name: true },
            })
            area = newArea as AreaResult
            console.log(`  📍 Created Area: ${row.area} (Department: ${row.department})`)
          }
          areaMap.set(areaKey, area)
        }

        // Normalize phone
        const phoneResult = normalizePhone(row.phone)

        if (!phoneResult.valid) {
          stats.invalid++
          stats.details.invalidRows.push({
            row: rowNum,
            reason: `${row.nama}: ${phoneResult.reason || 'invalid phone number'}`,
          })
          continue
        }

        // Upsert contact
        try {
          await prisma.contact.upsert({
            where: {
              areaId_phoneNorm: {
                areaId: area.id,
                phoneNorm: phoneResult.normalized,
              },
            },
            create: {
              storeName: row.nama,
              phoneRaw: phoneResult.raw,
              phoneNorm: phoneResult.normalized,
              phoneValid: true,
              contactType: 'KARDUS',
              areaId: area.id,
              departmentId: dept.id,
            },
            update: {
              storeName: row.nama,
              phoneRaw: phoneResult.raw,
              phoneValid: true,
            },
          })

          stats.imported++

          // Print progress every 50 records
          if ((stats.imported + stats.invalid) % 50 === 0) {
            console.log(
              `  ✓ Processed ${stats.imported + stats.invalid}/${rows.length} (${stats.imported} imported, ${stats.invalid} invalid)`,
            )
          }
        } catch (error: any) {
          // Check if it's a duplicate constraint violation
          if (error.code === 'P2002' && error.meta?.target?.includes('areaId_phoneNorm')) {
            stats.duplicates++
          } else {
            throw error
          }
        }
      } catch (error: any) {
        stats.invalid++
        stats.details.invalidRows.push({
          row: rowNum,
          reason: `${row.nama}: ${error.message}`,
        })
      }
    }

    console.log('\n' + '='.repeat(60))
    console.log('📊 IMPORT SUMMARY')
    console.log('='.repeat(60))
    console.log(`  Total Records:     ${stats.total}`)
    console.log(`  ✅ Imported:        ${stats.imported}`)
    console.log(`  ⚠️  Invalid:        ${stats.invalid}`)
    console.log(`  🔄 Duplicates:     ${stats.duplicates}`)
    console.log('='.repeat(60) + '\n')

    if (stats.invalid > 0 && stats.details.invalidRows.length > 0) {
      console.log('❌ Invalid Records:')
      stats.details.invalidRows.slice(0, 10).forEach((row) => {
        console.log(`  Row ${row.row}: ${row.reason}`)
      })
      if (stats.details.invalidRows.length > 10) {
        console.log(`  ... and ${stats.details.invalidRows.length - 10} more`)
      }
      console.log()
    }

    return stats
  } finally {
    await prisma.$disconnect()
  }
}