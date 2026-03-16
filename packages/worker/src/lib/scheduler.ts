import { toZonedTime } from 'date-fns-tz'

const TIMEZONE = process.env.TIMEZONE ?? 'Asia/Jakarta'

// Parse HH:MM into total minutes since midnight
function toMinutes(hhmm: string, fallback: number): number {
  const [h, m] = hhmm.split(':').map(Number)
  if (isNaN(h)) return fallback
  return h * 60 + (isNaN(m) ? 0 : m)
}

const START_MINUTES = toMinutes(process.env.WORKING_HOURS_START ?? '8:00',  8  * 60)
const END_MINUTES   = toMinutes(process.env.WORKING_HOURS_END   ?? '17:00', 17 * 60)
const START_HOUR    = Math.floor(START_MINUTES / 60)
const START_MIN     = START_MINUTES % 60

const WORKING_DAYS = (process.env.WORKING_DAYS ?? '1,2,3,4,5,6')
  .split(',')
  .map(Number)

const RATE_MEAN   = parseInt(process.env.RATE_LIMIT_MEAN_MS   ?? '35000', 10)
const RATE_STDDEV = parseInt(process.env.RATE_LIMIT_STDDEV_MS ?? '8000',  10)
const RATE_MIN    = parseInt(process.env.RATE_LIMIT_MIN_MS    ?? '20000', 10)
const RATE_MAX    = parseInt(process.env.RATE_LIMIT_MAX_MS    ?? '90000', 10)

const BREAK_MIN = parseInt(process.env.MID_SESSION_BREAK_MIN_MS ?? '180000', 10)
const BREAK_MAX = parseInt(process.env.MID_SESSION_BREAK_MAX_MS ?? '480000', 10)

export function isWorkingHours(): boolean {
  const now     = toZonedTime(new Date(), TIMEZONE)
  const day     = now.getDay() === 0 ? 7 : now.getDay() // 1=Mon, 7=Sun
  const current = now.getHours() * 60 + now.getMinutes()
  return WORKING_DAYS.includes(day) && current >= START_MINUTES && current < END_MINUTES
}

export function msUntilNextOpen(): number {
  const now    = new Date()
  const zoned  = toZonedTime(now, TIMEZONE)
  let candidate = new Date(zoned)

  // Advance to next START_HOUR:START_MIN
  candidate.setHours(START_HOUR, START_MIN, 0, 0)
  if (candidate <= zoned) {
    candidate.setDate(candidate.getDate() + 1)
  }

  // Skip non-working days
  let tries = 0
  while (tries < 14) {
    const day = candidate.getDay() === 0 ? 7 : candidate.getDay()
    if (WORKING_DAYS.includes(day)) break
    candidate.setDate(candidate.getDate() + 1)
    tries++
  }

  return candidate.getTime() - now.getTime()
}

/** Box-Muller Gaussian delay */
export function gaussianDelay(): number {
  const u1 = Math.random()
  const u2 = Math.random()
  const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  const ms = RATE_MEAN + z * RATE_STDDEV
  return Math.min(Math.max(ms, RATE_MIN), RATE_MAX)
}

/** Random break duration. Optional min/max override per-agent; falls back to env defaults. */
export function randomBreakDuration(min = BREAK_MIN, max = BREAK_MAX): number {
  return min + Math.random() * (max - min)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
