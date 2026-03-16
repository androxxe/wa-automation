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
        // Agent break defaults — read-only, sourced from env vars
        defaultBreakEvery:  parseInt(process.env.MID_SESSION_BREAK_EVERY  ?? '30',     10),
        defaultBreakMinSec: Math.round(parseInt(process.env.MID_SESSION_BREAK_MIN_MS ?? '180000', 10) / 1000),
        defaultBreakMaxSec: Math.round(parseInt(process.env.MID_SESSION_BREAK_MAX_MS ?? '480000', 10) / 1000),
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
        defaultBreakEvery:  parseInt(process.env.MID_SESSION_BREAK_EVERY  ?? '30',     10),
        defaultBreakMinSec: Math.round(parseInt(process.env.MID_SESSION_BREAK_MIN_MS ?? '180000', 10) / 1000),
        defaultBreakMaxSec: Math.round(parseInt(process.env.MID_SESSION_BREAK_MAX_MS ?? '480000', 10) / 1000),
      },
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

export default router
