import fs from 'fs'
import { db } from './db'
import { redis } from './queue'

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

function checkGeminiKey(): { pass: boolean; reason?: string } {
  const val = process.env.GOOGLE_API_KEY ?? ''
  if (!val)
    return { pass: false, reason: 'not set' }
  return { pass: true }
}

function checkDatabaseUrl(): { pass: boolean; reason?: string } {
  const val = process.env.DATABASE_URL ?? ''
  if (!val.startsWith('mysql://'))
    return { pass: false, reason: 'must start with mysql://' }
  return { pass: true }
}

function checkDataFolder(): { pass: boolean; reason?: string } {
  const val = process.env.DATA_FOLDER ?? ''
  if (!fs.existsSync(val))
    return { pass: false, reason: `directory not found: ${val}` }
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

type Provider = 'anthropic' | 'openai' | 'gemini'
const PROVIDER: Provider = (process.env.LLM_PROVIDER?.toLowerCase() ?? 'anthropic') as Provider

export async function validateStartup(): Promise<void> {
  console.log()
  console.log(bold('  Startup checks'))
  console.log()

  // ── 1. Environment variables ──────────────────────────────────────────────
  console.log(dim('  environment variables'))

  const envChecks: Check[] = [
    { label: 'DATABASE_URL (present)',       result: checkEnvVar('DATABASE_URL') },
    { label: 'DATABASE_URL (format)',        result: checkDatabaseUrl() },
    { label: 'REDIS_URL',                   result: checkEnvVar('REDIS_URL') },
    { label: 'DATA_FOLDER',                 result: checkEnvVar('DATA_FOLDER') },
    { label: 'DATA_FOLDER (exists)',        result: checkDataFolder() },
    { label: 'OUTPUT_FOLDER',              result: checkEnvVar('OUTPUT_FOLDER') },
  ]

  if (PROVIDER === 'anthropic') {
    envChecks.unshift(
      { label: 'LLM_PROVIDER', result: { pass: true } },
      { label: 'ANTHROPIC_API_KEY (present)', result: checkEnvVar('ANTHROPIC_API_KEY') },
      { label: 'ANTHROPIC_API_KEY (format)',  result: checkAnthropicKey() },
    )
  } else if (PROVIDER === 'gemini') {
    envChecks.unshift(
      { label: 'LLM_PROVIDER', result: { pass: true } },
      { label: 'GOOGLE_API_KEY', result: checkGeminiKey() },
    )
  } else {
    envChecks.unshift(
      { label: 'LLM_PROVIDER', result: { pass: true } },
    )
  }

  const envFailures = printResults(envChecks)

  // Abort early — no point testing connections with bad config
  if (envFailures > 0) {
    console.log()
    console.log(red(bold(`  ${envFailures} check(s) failed — fix the issues above and restart\n`)))
    process.exit(1)
  }

  // ── 2. Connections ────────────────────────────────────────────────────────
  console.log()
  console.log(dim('  connections'))

  const connChecks: Check[] = [
    { label: 'MySQL database', result: await checkDatabase() },
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
