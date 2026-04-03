import path from 'path'
import fs   from 'fs'
import { Router } from 'express'
import { db } from '../lib/db'
import { redis } from '../lib/queue'
import { normalizePhone } from '../lib/phone'

const OUTPUT_FOLDER = process.env.OUTPUT_FOLDER ?? ''

const router: import('express').Router = Router()

// ─── GET /api/replies ─────────────────────────────────────────────────────────
// Query params:
//   campaignId  — filter by campaign
//   category    — 'confirmed'|'denied'|'question'|'unclear'|'other'
//   jawaban     — '1' (yes) | '0' (no) | 'null' (unclear)
//   page        — default 1
//   limit       — default 50, max 200

router.get('/', async (req, res) => {
  try {
    const {
      campaignId,
      category,
      jawaban,
      page:  pageStr  = '1',
      limit: limitStr = '50',
    } = req.query as Record<string, string>

    const page  = Math.max(1, parseInt(pageStr, 10) || 1)
    const limit = Math.min(200, Math.max(1, parseInt(limitStr, 10) || 50))
    const skip  = (page - 1) * limit

    // Build the where clause for the Reply model
    const where: Record<string, unknown> = {}

    if (campaignId) {
      where.message = { campaignId }
    }

    if (category) {
      where.claudeCategory = category
    }

    if (jawaban !== undefined && jawaban !== '') {
      if (jawaban === 'null') {
        where.jawaban = null
      } else {
        where.jawaban = parseInt(jawaban, 10)
      }
    }

    const [replies, total] = await Promise.all([
      db.reply.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        skip,
        take: limit,
        select: {
          id:              true,
          body:            true,
          claudeCategory:  true,
          claudeSentiment: true,
          claudeSummary:   true,
          jawaban:         true,
          screenshotPath:  true,
          receivedAt:      true,
          message: {
            select: {
              id:         true,
              phone:      true,
              sentAt:     true,
              body:       true,
              campaignId: true,
              campaign: {
                select: { id: true, name: true, bulan: true, campaignType: true },
              },
              contact: {
                select: {
                  storeName: true,
                  department: { select: { name: true } },
                  area:       { select: { name: true } },
                },
              },
            },
          },
        },
      }),
      db.reply.count({ where }),
    ])

    // Stats for the current filter (minus pagination)
    const statsWhere: Record<string, unknown> = { ...where }
    const rawStats = await db.reply.groupBy({
      by:    ['claudeCategory'],
      where: statsWhere,
      _count: { id: true },
    })

    const stats = {
      total,
      confirmed: 0,
      denied:    0,
      question:  0,
      unclear:   0,
      other:     0,
    } as Record<string, number>
    for (const s of rawStats) {
      const key = s.claudeCategory ?? 'other'
      stats[key] = s._count.id
    }

    res.json({
      ok:   true,
      data: {
        replies,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
        stats,
      },
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── GET /api/replies/screenshot — serve a reply screenshot file ──────────────
// Query param: ?p=relative/path/to/screenshot.jpg
// The path must be relative and inside OUTPUT_FOLDER (no directory traversal).

router.get('/screenshot', (req, res) => {
  const rel = req.query.p as string | undefined
  if (!rel || !OUTPUT_FOLDER) {
    res.status(404).json({ ok: false, error: 'Not found' })
    return
  }

  // Prevent directory traversal
  const abs      = path.resolve(OUTPUT_FOLDER, rel)
  const baseAbs  = path.resolve(OUTPUT_FOLDER)
  if (!abs.startsWith(baseAbs + path.sep) && abs !== baseAbs) {
    res.status(403).json({ ok: false, error: 'Forbidden' })
    return
  }

  if (!fs.existsSync(abs)) {
    res.status(404).json({ ok: false, error: 'Screenshot not found' })
    return
  }

  res.sendFile(abs)
})

// ─── POST /api/replies/poll-manual — trigger manual reply poll for specific phones ─
// Body: { phones: string[] }
// Normalizes each phone, finds unreplied messages (including EXPIRED), groups by
// sending agent, and publishes a Redis command for the worker to poll immediately.

router.post('/poll-manual', async (req, res) => {
  try {
    const { phones: rawPhones } = req.body as { phones?: string[] }

    if (!rawPhones || !Array.isArray(rawPhones) || rawPhones.length === 0) {
      res.status(400).json({ ok: false, error: 'phones must be a non-empty array of phone numbers' })
      return
    }

    // Cap at 100 phones per request to prevent abuse
    if (rawPhones.length > 100) {
      res.status(400).json({ ok: false, error: 'Maximum 100 phones per request' })
      return
    }

    // Normalize all phone numbers
    const normalized: Array<{ raw: string; phone: string; valid: boolean; reason?: string }> = []
    for (const raw of rawPhones) {
      const result = normalizePhone(raw)
      normalized.push({
        raw:    raw.trim(),
        phone:  result.normalized,
        valid:  result.valid,
        reason: result.reason,
      })
    }

    const invalidPhones = normalized.filter((p) => !p.valid)
    const validPhones   = normalized.filter((p) => p.valid)

    if (validPhones.length === 0) {
      res.json({
        ok:   true,
        data: {
          queued:  [],
          skipped: invalidPhones.map((p) => ({ phone: p.raw, reason: `Invalid: ${p.reason}` })),
        },
      })
      return
    }

    // Find unreplied messages for these phones — include EXPIRED so manual poll
    // can catch replies the automatic system missed after expiration.
    const messages = await db.message.findMany({
      where: {
        phone:   { in: validPhones.map((p) => p.phone) },
        status:  { in: ['SENT', 'DELIVERED', 'READ', 'EXPIRED'] },
        reply:   null,
        agentId: { not: null },
      },
      select: { phone: true, sentAt: true, agentId: true },
    })

    // Group by agentId, deduplicating by phone (keep most recent sentAt)
    const byAgent = new Map<number, Map<string, string>>() // agentId → phone → sentAt ISO
    for (const m of messages) {
      const agentId = m.agentId!
      if (!byAgent.has(agentId)) byAgent.set(agentId, new Map())
      const agentMap = byAgent.get(agentId)!
      const ts = m.sentAt ?? new Date(0)
      const existing = agentMap.get(m.phone)
      if (!existing || ts.toISOString() > existing) {
        agentMap.set(m.phone, ts.toISOString())
      }
    }

    // Track which phones were found and which were not
    const foundPhones = new Set(messages.map((m) => m.phone))
    const skipped = [
      ...invalidPhones.map((p) => ({ phone: p.raw, reason: `Invalid: ${p.reason}` })),
      ...validPhones
        .filter((p) => !foundPhones.has(p.phone))
        .map((p) => ({ phone: p.phone, reason: 'No unreplied message found for this phone' })),
    ]

    const queued: Array<{ phone: string; agentId: number }> = []

    if (byAgent.size > 0) {
      // Serialize the map for Redis: { byAgent: { [agentId]: { [phone]: sentAtISO } } }
      const payload: Record<string, Record<string, string>> = {}
      for (const [agentId, phoneMap] of byAgent) {
        payload[String(agentId)] = Object.fromEntries(phoneMap)
        for (const phone of phoneMap.keys()) {
          queued.push({ phone, agentId })
        }
      }

      await redis.publish('reply:poll-manual', JSON.stringify({ byAgent: payload }))
    }

    res.json({
      ok:   true,
      data: { queued, skipped },
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

export default router
