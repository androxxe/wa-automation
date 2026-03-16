/**
 * clean-profiles.ts
 *
 * Deletes all Chromium browser profile directories and resets every agent's
 * status to OFFLINE in the database.
 *
 * Usage:
 *   pnpm clean:profiles
 *
 * The profile path is read from BROWSER_PROFILE_PATH (or BROWSER_PROFILES_DIR)
 * in the root .env file — relative paths are resolved from packages/worker/.
 * Falls back to ./browser-profile if neither env var is set.
 */

import fs   from 'fs'
import path from 'path'
import { config } from 'dotenv'
import { PrismaClient } from '@prisma/client'

// Load root .env (two levels up from scripts/)
config({ path: path.resolve(__dirname, '../.env') })

const WORKER_DIR  = path.resolve(__dirname, '../packages/worker')
const PROFILES_DIR = path.resolve(
  WORKER_DIR,
  process.env.BROWSER_PROFILE_PATH ?? process.env.BROWSER_PROFILES_DIR ?? './browser-profile',
)

async function main() {
  console.log('\n[clean-profiles] Starting...')
  console.log(`[clean-profiles] Profile directory: ${PROFILES_DIR}`)

  // ── 1. Delete profile directory ──────────────────────────────────────────────
  if (fs.existsSync(PROFILES_DIR)) {
    fs.rmSync(PROFILES_DIR, { recursive: true, force: true })
    console.log('[clean-profiles] ✓ Profile directory deleted.')
  } else {
    console.log('[clean-profiles] Profile directory does not exist — nothing to delete.')
  }

  // ── 2. Reset all agent statuses to OFFLINE in DB ─────────────────────────────
  const db = new PrismaClient()
  try {
    const { count } = await db.agent.updateMany({
      data: { status: 'OFFLINE' },
    })
    console.log(`[clean-profiles] ✓ Reset ${count} agent(s) to OFFLINE in the database.`)
  } finally {
    await db.$disconnect()
  }

  console.log('[clean-profiles] Done.\n')
}

main().catch((err) => {
  console.error('[clean-profiles] Error:', err)
  process.exit(1)
})
