import { toZonedTime } from 'date-fns-tz'

const TIMEZONE = process.env.TIMEZONE ?? 'Asia/Jakarta'
const START_HOUR = parseInt(process.env.WORKING_HOURS_START?.split(':')[0] ?? '8', 10)
const END_HOUR = parseInt(process.env.WORKING_HOURS_END?.split(':')[0] ?? '17', 10)
const WORKING_DAYS = (process.env.WORKING_DAYS ?? '1,2,3,4,5,6')
  .split(',')
  .map(Number)

const RATE_MEAN = parseInt(process.env.RATE_LIMIT_MEAN_MS ?? '35000', 10)
const RATE_STDDEV = parseInt(process.env.RATE_LIMIT_STDDEV_MS ?? '8000', 10)
const RATE_MIN = parseInt(process.env.RATE_LIMIT_MIN_MS ?? '20000', 10)
const RATE_MAX = parseInt(process.env.RATE_LIMIT_MAX_MS ?? '90000', 10)

const BREAK_MIN = parseInt(process.env.MID_SESSION_BREAK_MIN_MS ?? '180000', 10)
const BREAK_MAX = parseInt(process.env.MID_SESSION_BREAK_MAX_MS ?? '480000', 10)

export function isWorkingHours(): boolean {
  const now = toZonedTime(new Date(), TIMEZONE)
  const day = now.getDay() === 0 ? 7 : now.getDay() // 1=Mon, 7=Sun
  const hour = now.getHours()
  return WORKING_DAYS.includes(day) && hour >= START_HOUR && hour < END_HOUR
}

export function msUntilNextOpen(): number {
  const now = new Date()
  const zoned = toZonedTime(now, TIMEZONE)
  let candidate = new Date(zoned)

  // Advance to next START_HOUR
  candidate.setHours(START_HOUR, 0, 0, 0)
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
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
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
