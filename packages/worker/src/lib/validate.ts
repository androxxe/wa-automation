import { db } from './db'
import { redis } from './redis'

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const ok   = '\x1b[32m✓\x1b[0m'
const fail = '\x1b[31m✗\x1b[0m'
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const dim  = (s: string) => `\x1b[2m${s}\x1b[0m`
const red  = (s: string) => `\x1b[31m${s}\x1b[0m`

// ─── Checks ───────────────────────────────────────────────────────────────────

const PLACEHOLDERS = ['sk-ant-...', '/absolute/path/to', 'password']

function checkEnvVar(key: string): { pass: boolean; reason?: string } {
  const val = process.env[key]
  if (!val) return { pass: false, reason: 'not set' }
  if (PLACEHOLDERS.some((p) => val.includes(p)))
    return { pass: false, reason: 'still has placeholder value' }
  return { pass: true }
}

function checkAnthropicKey(): { pass: boolean; reason?: string } {
  const val = process.env.ANTHROPIC_API_KEY ?? ''
  if (!val.startsWith('sk-ant-'))
    return { pass: false, reason: 'must start with sk-ant-' }
  return { pass: true }
}

function checkDatabaseUrl(): { pass: boolean; reason?: string } {
  const val = process.env.DATABASE_URL ?? ''
  if (!val.startsWith('postgresql://') && !val.startsWith('postgres://'))
    return { pass: false, reason: 'must start with postgresql:// or postgres://' }
  return { pass: true }
}

async function checkDatabase(): Promise<{ pass: boolean; reason?: string }> {
  try {
    await db.$queryRaw`SELECT 1`
    return { pass: true }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { pass: false, reason: msg }
  }
}

async function checkRedis(): Promise<{ pass: boolean; reason?: string }> {
  try {
    await redis.ping()
    return { pass: true }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { pass: false, reason: msg }
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

type Check = { label: string; result: { pass: boolean; reason?: string } }

function printResults(checks: Check[]): number {
  const width = Math.max(...checks.map((c) => c.label.length)) + 2
  let failures = 0
  for (const { label, result } of checks) {
    const icon = result.pass ? ok : fail
    const note = result.pass ? '' : dim(`  — ${result.reason}`)
    console.log(`  ${icon}  ${label.padEnd(width)}${note}`)
    if (!result.pass) failures++
  }
  return failures
}

export async function validateStartup(): Promise<void> {
  console.log()
  console.log(bold('  Startup checks'))
  console.log()

  // ── 1. Environment variables ──────────────────────────────────────────────
  console.log(dim('  environment variables'))

  const envChecks: Check[] = [
    { label: 'ANTHROPIC_API_KEY (present)', result: checkEnvVar('ANTHROPIC_API_KEY') },
    { label: 'ANTHROPIC_API_KEY (format)',  result: checkAnthropicKey() },
    { label: 'DATABASE_URL (present)',      result: checkEnvVar('DATABASE_URL') },
    { label: 'DATABASE_URL (format)',       result: checkDatabaseUrl() },
    { label: 'REDIS_URL',                  result: checkEnvVar('REDIS_URL') },
  ]

  const envFailures = printResults(envChecks)

  if (envFailures > 0) {
    console.log()
    console.log(red(bold(`  ${envFailures} check(s) failed — fix the issues above and restart\n`)))
    process.exit(1)
  }

  // ── 2. Connections ────────────────────────────────────────────────────────
  console.log()
  console.log(dim('  connections'))

  const connChecks: Check[] = [
    { label: 'PostgreSQL database', result: await checkDatabase() },
    { label: 'Redis',          result: await checkRedis() },
  ]

  const connFailures = printResults(connChecks)

  console.log()

  if (connFailures > 0) {
    console.log(red(bold(`  ${connFailures} check(s) failed — fix the issues above and restart\n`)))
    process.exit(1)
  }

  console.log(bold('  All checks passed\n'))
}
