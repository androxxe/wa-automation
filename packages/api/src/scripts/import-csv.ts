#!/usr/bin/env ts-node
/**
 * CSV Import Script
 * Usage: npx ts-node packages/api/src/scripts/import-csv.ts <csv-file-path>
 */

import path from 'path'
import { importCSV } from '../lib/csv-import'

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    console.error('❌ Error: Please provide a CSV file path')
    console.error('Usage: npx ts-node packages/api/src/scripts/import-csv.ts <csv-file-path>')
    console.error('\nExample:')
    console.error('  npx ts-node packages/api/src/scripts/import-csv.ts data_kardus_updated.csv')
    console.error('  npx ts-node packages/api/src/scripts/import-csv.ts /absolute/path/to/file.csv')
    process.exit(1)
  }

  const csvPath = args[0]

  // Resolve to absolute path if relative
  const absolutePath = path.isAbsolute(csvPath)
    ? csvPath
    : path.resolve(process.cwd(), csvPath)

  console.log('\n' + '='.repeat(60))
  console.log('🚀 CSV IMPORT SCRIPT')
  console.log('='.repeat(60))
  console.log(`📄 File: ${absolutePath}\n`)

  try {
    const stats = await importCSV(absolutePath)
    
    // Exit with error code if there were any invalid records
    process.exit(stats.invalid > 0 ? 1 : 0)
  } catch (error: any) {
    console.error('\n❌ Import failed:', error.message)
    process.exit(1)
  }
}

main()
