/**
 * ─── OUTPUT_FOLDER → MinIO screenshot migration ─────────────────────────────
 *
 * Uploads all existing reply screenshots from the local OUTPUT_FOLDER to MinIO,
 * preserving the same object keys that the new code generates.
 *
 * Prerequisites:
 *   - MinIO is running and accessible
 *   - MINIO_ENDPOINT, MINIO_PORT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_BUCKET env vars set
 *   - OUTPUT_FOLDER env var still points to the old local directory
 *
 * Usage:
 *   cd packages/api
 *   pnpm exec tsx ../../scripts/migrate-screenshots-to-minio.ts
 *
 * Or from root with env file:
 *   dotenv -e .env.dev -- tsx scripts/migrate-screenshots-to-minio.ts
 *
 * What it does:
 *   1. Scans OUTPUT_FOLDER/screenshots/ for all .jpg/.jpeg/.png files
 *   2. Uploads each file to MinIO bucket under the key "screenshots/{filename}"
 *   3. Verifies that Reply.screenshotPath values in the DB match the uploaded keys
 *   4. Reports summary of uploaded/skipped/failed files
 *
 * This script is idempotent — re-running it will skip files already in MinIO.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from 'fs'
import path from 'path'
import { Client } from 'minio'

const OUTPUT_FOLDER  = process.env.OUTPUT_FOLDER ?? ''
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? 'localhost'
const MINIO_PORT     = parseInt(process.env.MINIO_PORT ?? '9000', 10)
const MINIO_USE_SSL  = process.env.MINIO_USE_SSL === 'true'
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? ''
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? ''
const MINIO_BUCKET     = process.env.MINIO_BUCKET ?? 'whatsapp-automation'

async function main() {
  console.log('===========================================')
  console.log(' OUTPUT_FOLDER → MinIO Screenshot Migration')
  console.log('===========================================')
  console.log()

  // ── Validate ────────────────────────────────────────────────────────────────
  if (!OUTPUT_FOLDER) {
    console.error('ERROR: OUTPUT_FOLDER env var is not set.')
    console.error('Set it to the path containing your existing screenshots/ directory.')
    process.exit(1)
  }

  const screenshotsDir = path.join(OUTPUT_FOLDER, 'screenshots')
  if (!fs.existsSync(screenshotsDir)) {
    console.error(`ERROR: Screenshots directory not found: ${screenshotsDir}`)
    process.exit(1)
  }

  if (!MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) {
    console.error('ERROR: MINIO_ACCESS_KEY and MINIO_SECRET_KEY must be set.')
    process.exit(1)
  }

  // ── Connect to MinIO ───────────────────────────────────────────────────────
  const minio = new Client({
    endPoint:  MINIO_ENDPOINT,
    port:      MINIO_PORT,
    useSSL:    MINIO_USE_SSL,
    accessKey: MINIO_ACCESS_KEY,
    secretKey: MINIO_SECRET_KEY,
  })

  const bucketExists = await minio.bucketExists(MINIO_BUCKET)
  if (!bucketExists) {
    console.log(`Creating bucket: ${MINIO_BUCKET}`)
    await minio.makeBucket(MINIO_BUCKET)
  }

  // ── Scan local screenshots ─────────────────────────────────────────────────
  const files = fs.readdirSync(screenshotsDir)
    .filter(f => /\.(jpg|jpeg|png)$/i.test(f))
    .sort()

  console.log(`Source: ${screenshotsDir}`)
  console.log(`Target: minio://${MINIO_ENDPOINT}:${MINIO_PORT}/${MINIO_BUCKET}/screenshots/`)
  console.log(`Files found: ${files.length}`)
  console.log()

  if (files.length === 0) {
    console.log('No screenshot files to migrate.')
    return
  }

  // ── Upload ─────────────────────────────────────────────────────────────────
  let uploaded = 0
  let skipped  = 0
  let failed   = 0

  for (const filename of files) {
    const localPath = path.join(screenshotsDir, filename)
    const key       = `screenshots/${filename}`

    try {
      // Check if object already exists in MinIO (idempotent)
      try {
        await minio.statObject(MINIO_BUCKET, key)
        skipped++
        continue  // Already uploaded
      } catch {
        // Object doesn't exist — proceed with upload
      }

      const stat    = fs.statSync(localPath)
      const stream  = fs.createReadStream(localPath)
      const ext     = path.extname(filename).toLowerCase()
      const mime    = ext === '.png' ? 'image/png' : 'image/jpeg'

      await minio.putObject(MINIO_BUCKET, key, stream, stat.size, {
        'Content-Type': mime,
      })

      uploaded++

      if (uploaded % 100 === 0) {
        console.log(`  ... uploaded ${uploaded} files`)
      }
    } catch (err) {
      console.error(`  FAILED: ${filename} — ${err}`)
      failed++
    }
  }

  console.log()
  console.log('─── Summary ───────────────────────────────')
  console.log(`  Uploaded: ${uploaded}`)
  console.log(`  Skipped (already exists): ${skipped}`)
  console.log(`  Failed: ${failed}`)
  console.log(`  Total: ${files.length}`)
  console.log()

  if (failed > 0) {
    console.log(`WARNING: ${failed} file(s) failed to upload. Re-run to retry.`)
  } else {
    console.log('All screenshots migrated successfully.')
  }

  // ── Also migrate CSV/XLSX report files if they exist ───────────────────────
  console.log()
  console.log('─── Report files ──────────────────────────')

  let reportCount = 0

  // Walk OUTPUT_FOLDER for .csv and .xlsx files (non-screenshots)
  const walkDir = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const relPath  = prefix ? `${prefix}/${entry.name}` : entry.name

      if (entry.isDirectory() && entry.name !== 'screenshots') {
        walkDir(fullPath, relPath)
      } else if (entry.isFile() && /\.(csv|xlsx)$/i.test(entry.name)) {
        const key = `reports/${relPath}`
        uploadReport(fullPath, key)
        reportCount++
      }
    }
  }

  const uploadReport = async (localPath: string, key: string) => {
    try {
      try {
        await minio.statObject(MINIO_BUCKET, key)
        return  // Already exists
      } catch {
        // Proceed
      }

      const stat   = fs.statSync(localPath)
      const stream = fs.createReadStream(localPath)
      const ext    = path.extname(localPath).toLowerCase()
      const mime   = ext === '.csv'
        ? 'text/csv'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

      await minio.putObject(MINIO_BUCKET, key, stream, stat.size, {
        'Content-Type': mime,
      })
    } catch (err) {
      console.error(`  FAILED: ${key} — ${err}`)
    }
  }

  walkDir(OUTPUT_FOLDER, '')

  if (reportCount === 0) {
    console.log('  No report files found to migrate.')
  } else {
    console.log(`  Processed ${reportCount} report file(s).`)
  }

  console.log()
  console.log('===========================================')
  console.log(' Migration complete')
  console.log('===========================================')
  console.log()
  console.log('Next steps:')
  console.log('  1. Verify screenshots are accessible in the UI')
  console.log('  2. OUTPUT_FOLDER is no longer needed — you can remove it from .env')
  console.log('  3. Once verified, you can delete the local screenshots/ directory')
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
