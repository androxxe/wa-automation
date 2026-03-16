/**
 * prod-guard.ts
 *
 * Wraps a destructive command with two layers of protection:
 *   1. Hard block when NODE_ENV=production — no override possible.
 *   2. Confirmation prompt when DATABASE_URL / REDIS_URL points to a
 *      non-localhost host, indicating a remote (possibly production) server.
 *
 * Usage (pass the full command as arguments):
 *   tsx ../../scripts/prod-guard.ts prisma migrate reset --schema=prisma/schema.prisma
 *   tsx ../../scripts/prod-guard.ts redis-cli -p 6380 FLUSHALL
 *
 * Always run via a package.json script so the working directory is set
 * correctly (e.g. packages/api for Prisma commands).
 */

import path     from 'path'
import readline from 'readline'
import { config }    from 'dotenv'
import { execSync }  from 'child_process'

// ── Load root .env ────────────────────────────────────────────────────────────
// __dirname is scripts/ so ../  resolves to the project root.
config({ path: path.resolve(__dirname, '../.env') })

// ── Helpers ───────────────────────────────────────────────────────────────────
function isLocal(url: string): boolean {
  return /localhost|127\.0\.0\.1/.test(url)
}

function abort(reason: string): never {
  console.error(`\n  [prod-guard] BLOCKED — ${reason}\n`)
  process.exit(1)
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'yes')
    })
  })
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const command = process.argv.slice(2).join(' ')

  if (!command) {
    console.error('Usage: tsx prod-guard.ts <command ...args>')
    process.exit(1)
  }

  // ── Layer 1: hard block in production ─────────────────────────────────────
  if (process.env.NODE_ENV === 'production') {
    abort(`NODE_ENV is "production". Destructive command refused:\n  > ${command}`)
  }

  // ── Layer 2: confirmation when URL is non-local ────────────────────────────
  const dbUrl    = process.env.DATABASE_URL ?? ''
  const redisUrl = process.env.REDIS_URL    ?? ''

  // Determine which URL is relevant for this command
  const isRedisCmd  = command.includes('redis-cli') || command.includes('redis')
  const relevantUrl = isRedisCmd ? redisUrl : dbUrl
  const urlLabel    = isRedisCmd ? 'REDIS_URL' : 'DATABASE_URL'

  if (relevantUrl && !isLocal(relevantUrl)) {
    let host = relevantUrl
    try { host = new URL(relevantUrl).hostname } catch { /* keep raw */ }

    console.error(`\n  [prod-guard] WARNING`)
    console.error(`  ${urlLabel} points to a remote host: ${host}`)
    console.error(`  Command: ${command}`)
    console.error(`  This operation is DESTRUCTIVE and cannot be undone.\n`)

    const ok = await confirm('  Type "yes" to confirm you want to proceed: ')
    if (!ok) {
      abort('Confirmation not given. Aborted.')
    }
    console.log('')
  }

  // ── Run ────────────────────────────────────────────────────────────────────
  execSync(command, { stdio: 'inherit', cwd: process.cwd() })
}

main().catch((err: Error) => {
  console.error('[prod-guard] Unexpected error:', err.message)
  process.exit(1)
})
