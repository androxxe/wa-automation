import { Router } from 'express'
import { z } from 'zod'
import { db } from '../lib/db'

const router: import('express').Router = Router()

async function getOrCreateConfig() {
  return db.appConfig.upsert({
    where:  { id: 'singleton' },
    update: {},
    create: { id: 'singleton', defaultTargetRepliesPerArea: 20, defaultExpectedReplyRate: 0.5 },
  })
}

/** Read-only env-sourced config fields — shared by GET and PATCH responses. */
function envConfig() {
  return {
    // Agent defaults
    defaultDailySendCap:  parseInt(process.env.DAILY_SEND_CAP ?? '150', 10),
    defaultBreakEvery:    parseInt(process.env.MID_SESSION_BREAK_EVERY  ?? '30',     10),
    defaultBreakMinSec:   Math.round(parseInt(process.env.MID_SESSION_BREAK_MIN_MS ?? '180000', 10) / 1000),
    defaultBreakMaxSec:   Math.round(parseInt(process.env.MID_SESSION_BREAK_MAX_MS ?? '480000', 10) / 1000),
    defaultTypeDelayMin:  parseInt(process.env.TYPE_DELAY_MIN_MS ?? '80',  10),
    defaultTypeDelayMax:  parseInt(process.env.TYPE_DELAY_MAX_MS ?? '180', 10),
    // Working hours
    workingHoursStart:     process.env.WORKING_HOURS_START ?? '08:00',
    workingHoursEnd:       process.env.WORKING_HOURS_END   ?? '17:00',
    workingDays:           (process.env.WORKING_DAYS ?? '1,2,3,4,5,6').split(',').map(Number),
    timezone:              process.env.TIMEZONE ?? 'Asia/Jakarta',
    // Rate limiting
    rateLimitMeanMs:       parseInt(process.env.RATE_LIMIT_MEAN_MS   ?? '35000', 10),
    rateLimitStddevMs:     parseInt(process.env.RATE_LIMIT_STDDEV_MS ?? '8000',  10),
    rateLimitMinMs:        parseInt(process.env.RATE_LIMIT_MIN_MS    ?? '20000', 10),
    rateLimitMaxMs:        parseInt(process.env.RATE_LIMIT_MAX_MS    ?? '90000', 10),
    // Polling & concurrency
    replyPollIntervalMs:      parseInt(process.env.REPLY_POLL_INTERVAL_MS      ?? '60000', 10),
    campaignReplyWindowDays:  parseInt(process.env.CAMPAIGN_REPLY_WINDOW_DAYS  ?? '3',     10),
    phoneCheckConcurrency:    parseInt(process.env.PHONE_CHECK_CONCURRENCY     ?? '3',     10),
  }
}

// GET /api/config
router.get('/', async (_req, res) => {
  try {
    const cfg = await getOrCreateConfig()
    res.json({
      ok:   true,
      data: {
        defaultTargetRepliesPerArea: cfg.defaultTargetRepliesPerArea,
        defaultExpectedReplyRate:    cfg.defaultExpectedReplyRate,
        defaultSendPerArea:          Math.ceil(
          cfg.defaultTargetRepliesPerArea / cfg.defaultExpectedReplyRate,
        ),
        ...envConfig(),
      },
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// PATCH /api/config
const PatchConfig = z.object({
  defaultTargetRepliesPerArea: z.number().int().min(1).optional(),
  defaultExpectedReplyRate:    z.number().min(0.01).max(1).optional(),
})

router.patch('/', async (req, res) => {
  const parsed = PatchConfig.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.message })
    return
  }
  try {
    const cfg = await db.appConfig.upsert({
      where:  { id: 'singleton' },
      update: parsed.data,
      create: {
        id: 'singleton',
        defaultTargetRepliesPerArea: parsed.data.defaultTargetRepliesPerArea ?? 20,
        defaultExpectedReplyRate:    parsed.data.defaultExpectedReplyRate    ?? 0.5,
      },
    })
    res.json({
      ok:   true,
      data: {
        defaultTargetRepliesPerArea: cfg.defaultTargetRepliesPerArea,
        defaultExpectedReplyRate:    cfg.defaultExpectedReplyRate,
        defaultSendPerArea:          Math.ceil(
          cfg.defaultTargetRepliesPerArea / cfg.defaultExpectedReplyRate,
        ),
        ...envConfig(),
      },
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

export default router
