// ─── Batch Photo Processor — CLI ──────────────────────────────────────────
// Scans MANUAL_PHOTOS_FOLDER for WhatsApp chat screenshots, extracts reply
// data via LLM vision, and creates Reply records.
//
// Usage:
//   pnpm process:photos                  # dry run (no writes)
//   pnpm process:photos -- --live        # actually create replies
//   pnpm process:photos -- --live --batch 10  # process 10 files then stop
//
// Files are moved to processed/ subfolder after successful processing.

import path from 'path'
import fs from 'fs'
import * as opencode from '../lib/opencode'

const FOLDER = process.env.MANUAL_PHOTOS_FOLDER!
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
}

// ─── CLI flags ────────────────────────────────────────────────────────────

interface Flags {
  live:  boolean
  batch: number  // 0 = all
  delay: number  // ms between files
}

function parseFlags(): Flags {
  const args = process.argv.slice(2)
  const get = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  return {
    live:  args.includes('--live'),
    batch: parseInt(get('--batch') ?? '0', 10) || 0,
    delay: parseInt(get('--delay') ?? '0', 10) || 0,
  }
}

// ─── Print helpers ────────────────────────────────────────────────────────

const C = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m' }

function pad(s: string, n: number): string { return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length) }

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseFlags()

  if (!FOLDER) {
    console.error(`${C.red}MANUAL_PHOTOS_FOLDER is not set in env${C.reset}`)
    process.exit(1)
  }

  console.log(`\n${C.cyan}━━━ Batch Photo Processor ━━━${C.reset}`)
  console.log(`${C.dim}Folder: ${FOLDER}${C.reset}`)
  console.log(`${C.dim}Mode:   ${flags.live ? `${C.red}LIVE (writes DB)` : `${C.green}DRY RUN (no writes)`}${C.reset}`)
  console.log(`${C.dim}Batch:  ${flags.batch || 'all'}${C.reset}\n`)

  if (!fs.existsSync(FOLDER)) {
    console.error(`${C.red}Folder not found: ${FOLDER}${C.reset}`)
    process.exit(1)
  }

  const processedDir = path.join(FOLDER, 'processed')
  fs.mkdirSync(processedDir, { recursive: true })
  const failedDir = path.join(FOLDER, 'failed')
  fs.mkdirSync(failedDir, { recursive: true })

  const entries = fs.readdirSync(FOLDER, { withFileTypes: true })
  let files = entries
    .filter((e) => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort()

  if (flags.batch > 0) files = files.slice(0, flags.batch)

  if (files.length === 0) {
    console.log(`${C.yellow}No images found in folder${C.reset}`)
    return
  }

  console.log(`${C.dim}Found ${files.length} image(s) to process${C.reset}\n`)

  // ─── Header ──────────────────────────────────────────────────────────
  const wFile = Math.max(4, ...files.map((f) => f.length), 8)
  const hr = '─'.repeat(wFile + 18 + 10 + 10 + 30 + 18)

  if (!flags.live) {
    console.log(`${C.dim}${pad('File', wFile)}  Phone            Text         Jawaban  Category       Summary${C.reset}`)
    console.log(C.dim + hr + C.reset)
  }

  let success = 0
  let failed  = 0

  for (const filename of files) {
    const filePath = path.join(FOLDER, filename)
    const ext = path.extname(filename).toLowerCase()
    const mimeType = MIME_MAP[ext] ?? 'image/jpeg'

    try {
      const buf = fs.readFileSync(filePath)
      const b64 = buf.toString('base64')

      // ── Extract via LLM ────────────────────────────────────────────
      const extracted = await opencode.extractReplyFromImage(b64, mimeType)
      const phone = extracted.phone

      if (!phone || phone.length < 6) {
        if (!flags.live) {
          console.log(`${C.red}${pad(filename.slice(0, wFile), wFile)}  FAIL: No phone extracted${C.reset}`)
          console.log(`${C.dim}  raw: "${extracted.phone}" text: "${extracted.text.slice(0, 40)}"${C.reset}`)
        }
        failed++
        continue
      }

      if (flags.live) {
        // ── LIVE mode: create Reply + move file ──────────────────────
        // Defer db import until needed (avoids connection in dry run)
        const { db } = await import('../lib/db')
        const { normalizePhone } = await import('../lib/phone')

        const phoneResult = normalizePhone(phone)
        if (!phoneResult.valid) {
          console.log(`${C.red}✗ ${filename.slice(0, wFile)}  Invalid phone: ${phoneResult.reason}${C.reset}`)
          failed++
          fs.renameSync(filePath, path.join(failedDir, filename))
          continue
        }
        const normalizedPhone = phoneResult.normalized

        const REPLY_WINDOW_DAYS = parseInt(process.env.CAMPAIGN_REPLY_WINDOW_DAYS ?? '3', 10)
        const replyWindowCutoff = new Date(Date.now() - REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000)
        const unrepliedMessages = await db.message.findMany({
          where: {
            phone:   normalizedPhone,
            status:  { in: ['SENT', 'DELIVERED', 'READ', 'EXPIRED', 'FAILED'] },
            reply:   null,
            campaign: {
              OR: [
                { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
                { status: 'COMPLETED', completedAt: { gte: replyWindowCutoff } },
              ],
            },
          },
          include: { campaign: true, contact: { include: { area: true } } },
          orderBy: { sentAt: 'desc' },
        })

        if (unrepliedMessages.length === 0) {
          console.log(`${C.yellow}✗ ${filename.slice(0, wFile)}  No unreplied for ${normalizedPhone}${C.reset}`)
          failed++
          fs.renameSync(filePath, path.join(failedDir, filename))
          continue
        }

        const OUTPUT_FOLDER = process.env.OUTPUT_FOLDER
        const screenshotsDir = path.join(OUTPUT_FOLDER ?? '', 'screenshots')
        fs.mkdirSync(screenshotsDir, { recursive: true })
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const shotName = `${normalizedPhone.replace('+', '')}_${ts}.jpg`
        fs.copyFileSync(filePath, path.join(screenshotsDir, shotName))
        const screenshotPath = `screenshots/${shotName}`

        const apiUrl = `http://localhost:${process.env.PORT ?? 3001}`
        let created = 0

        for (const msg of unrepliedMessages) {
          const reply = await db.reply.create({
            data: {
              messageId:      msg.id,
              phone:          normalizedPhone,
              body:           extracted.text,
              screenshotPath,
              claudeCategory:  extracted.category,
              claudeSentiment: extracted.sentiment,
              claudeSummary:   extracted.summary,
              jawaban:         extracted.jawaban,
              claudeRaw:       { source: 'batch', file: filename },
            },
          }).catch((e) => {
            console.warn(`  [warn] reply.create failed for msg ${msg.id}:`, e)
            return null
          })
          if (!reply) continue
          created++

          const existingMeta = (msg.metadata && typeof msg.metadata === 'object' ? { ...(msg.metadata as Record<string, unknown>) } : {}) as Record<string, unknown>
          existingMeta.replySource = 'batch'
          existingMeta.replySourceFile = filename
          await db.message.update({ where: { id: msg.id }, data: { metadata: existingMeta as any } }).catch(() => {})

          if (msg.status !== 'READ') {
            await db.message.update({ where: { id: msg.id }, data: { status: 'READ', readAt: new Date() } })
            await db.campaign.update({ where: { id: msg.campaignId }, data: { readCount: { increment: 1 } } })
          }
          await db.campaign.update({ where: { id: msg.campaignId }, data: { replyCount: { increment: 1 } } })
          await db.campaignArea.updateMany({
            where: { campaignId: msg.campaignId, areaId: msg.contact.areaId },
            data:  { replyCount: { increment: 1 } },
          })

          fetch(`${apiUrl}/api/export/report-area`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ areaId: msg.contact.areaId, bulan: msg.campaign.bulan, campaignType: msg.contact.area.contactType }),
          }).catch(() => {})
        }

        fs.renameSync(filePath, path.join(processedDir, filename))
        console.log(`${C.green}✓ ${filename.slice(0, wFile)}  → ${normalizedPhone}  ${extracted.jawaban === 1 ? 'Ya' : extracted.jawaban === 0 ? 'Tidak' : '-'}  ${extracted.category}${C.reset}  (${created} msg)`)
        success++
      } else {
        // ── DRY RUN: just print the extracted data ─────────────────
        const j = extracted.jawaban === 1 ? `${C.green}Ya${C.reset}        ` : extracted.jawaban === 0 ? `${C.red}Tidak${C.reset}     ` : `${C.yellow}-${C.reset}          `
        console.log(
          `${pad(filename.slice(0, wFile), wFile)}  ${pad(extracted.phone, 16)}  ${pad(extracted.text.slice(0, 10), 10)}  ${j}  ${pad(extracted.category, 14)}  ${extracted.summary.slice(0, 28)}`
        )
        success++
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!flags.live) {
        console.log(`${C.red}${pad(filename.slice(0, wFile), wFile)}  FAIL: ${msg.slice(0, 60)}${C.reset}`)
      } else {
        console.log(`${C.red}✗ ${filename.slice(0, wFile)}  ${msg.slice(0, 60)}${C.reset}`)
        try { fs.renameSync(filePath, path.join(failedDir, filename)) } catch {}
      }
      failed++
    }

    if (flags.delay > 0 && files.indexOf(filename) < files.length - 1) {
      await new Promise((r) => setTimeout(r, flags.delay))
    }
  }

  // ─── Summary ──────────────────────────────────────────────────────────
  console.log(`\n${C.dim}${hr}${C.reset}`)
  console.log(`${C.green}✓ ${success}${C.reset} processed  ${C.red}✗ ${failed}${C.reset} failed  (${files.length} total)`)
  if (!flags.live) {
    console.log(`${C.yellow}\nDry run — no changes made. Add --live to create replies.${C.reset}`)
  }
}

main()
  .catch((err) => {
    console.error(`${C.red}Fatal:${C.reset}`, err)
    process.exit(1)
  })
