import path from 'path'
import fs   from 'fs'
import { Router } from 'express'
import { db } from '../lib/db'
import { redis } from '../lib/queue'
import { normalizePhone } from '../lib/phone'

const OUTPUT_FOLDER = process.env.OUTPUT_FOLDER ?? ''
const ALLOWED_REPLY_CATEGORIES = new Set(['confirmed', 'denied', 'question', 'unclear', 'other'])

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

// ─── PATCH /api/replies/:id — manual correction for classification/jawaban ───
// Body: { category?: ReplyCategory|null, jawaban?: 1|0|null }

router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const body = req.body as { category?: string | null; jawaban?: number | null }

    const hasCategory = Object.prototype.hasOwnProperty.call(body, 'category')
    const hasJawaban  = Object.prototype.hasOwnProperty.call(body, 'jawaban')

    if (!hasCategory && !hasJawaban) {
      res.status(400).json({ ok: false, error: 'Provide at least one field: category or jawaban' })
      return
    }

    const data: { claudeCategory?: string | null; jawaban?: number | null } = {}

    if (hasCategory) {
      const category = body.category
      if (category !== null && typeof category !== 'string') {
        res.status(400).json({ ok: false, error: 'category must be a string or null' })
        return
      }
      if (typeof category === 'string' && !ALLOWED_REPLY_CATEGORIES.has(category)) {
        res.status(400).json({ ok: false, error: 'Invalid category' })
        return
      }
      data.claudeCategory = category
    }

    if (hasJawaban) {
      const jawaban = body.jawaban
      if (jawaban !== null && jawaban !== 0 && jawaban !== 1) {
        res.status(400).json({ ok: false, error: 'jawaban must be 1, 0, or null' })
        return
      }
      data.jawaban = jawaban
    }

    const updated = await db.reply.update({
      where: { id },
      data,
      select: {
        id:             true,
        claudeCategory: true,
        jawaban:        true,
      },
    }).catch(() => null)

    if (!updated) {
      res.status(404).json({ ok: false, error: 'Reply not found' })
      return
    }

    res.json({ ok: true, data: updated })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── POST /api/replies/poll-manual — trigger manual reply poll for specific phones ─
// Body: { phones: string[] }
// Normalizes each phone and finds a per-phone polling anchor, grouped by sending agent:
//   1) Prefer the latest unreplied message (including EXPIRED/FAILED)
//   2) Fallback to the latest message if no unreplied message exists
// This ensures manual poll still triggers the worker for replied phones.

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

    // Step 1: Find unreplied messages for these phones.
    // Includes EXPIRED and FAILED to allow manual recovery checks when status
    // drift happened (e.g. actually sent but marked FAILED).
    const unrepliedMessages = await db.message.findMany({
      where: {
        phone:   { in: validPhones.map((p) => p.phone) },
        status:  { in: ['SENT', 'DELIVERED', 'READ', 'EXPIRED', 'FAILED'] },
        reply:   null,
        agentId: { not: null },
      },
      select: { phone: true, sentAt: true, createdAt: true, agentId: true },
    })

    type ManualPollAnchor = {
      phone: string
      sentAt: Date
      agentId: number
      mode: 'unreplied' | 'fallback_latest'
    }

    const selectedByPhone = new Map<string, ManualPollAnchor>()

    // Deduplicate unreplied by phone (keep most recent sentAt)
    for (const m of unrepliedMessages) {
      const ts = m.sentAt ?? m.createdAt
      const existing = selectedByPhone.get(m.phone)
      if (!existing || ts > existing.sentAt) {
        selectedByPhone.set(m.phone, {
          phone: m.phone,
          sentAt: ts,
          agentId: m.agentId!,
          mode: 'unreplied',
        })
      }
    }

    // Step 2 (fallback): for phones with no unreplied message, use latest
    // message so manual poll can still force a worker-side check.
    const fallbackPhones = validPhones
      .map((p) => p.phone)
      .filter((phone) => !selectedByPhone.has(phone))

    if (fallbackPhones.length > 0) {
      const fallbackMessages = await db.message.findMany({
        where: {
          phone:   { in: fallbackPhones },
          status:  { in: ['SENT', 'DELIVERED', 'READ', 'EXPIRED', 'FAILED'] },
          agentId: { not: null },
        },
        select: { phone: true, sentAt: true, createdAt: true, agentId: true },
      })

      for (const m of fallbackMessages) {
        const ts = m.sentAt ?? m.createdAt
        const existing = selectedByPhone.get(m.phone)
        if (!existing || ts > existing.sentAt) {
          selectedByPhone.set(m.phone, {
            phone: m.phone,
            sentAt: ts,
            agentId: m.agentId!,
            mode: 'fallback_latest',
          })
        }
      }
    }

    // Group by agentId for Redis payload
    const byAgent = new Map<number, Map<string, string>>() // agentId → phone → sentAt ISO
    for (const selected of selectedByPhone.values()) {
      if (!byAgent.has(selected.agentId)) byAgent.set(selected.agentId, new Map())
      byAgent.get(selected.agentId)!.set(selected.phone, selected.sentAt.toISOString())
    }

    // Track which phones were found and which were not
    const foundPhones = new Set(selectedByPhone.keys())
    const skipped = [
      ...invalidPhones.map((p) => ({ phone: p.raw, reason: `Invalid: ${p.reason}` })),
      ...validPhones
        .filter((p) => !foundPhones.has(p.phone))
        .map((p) => ({ phone: p.phone, reason: 'No sent message with assigned agent found for this phone' })),
    ]

    const queued: Array<{ phone: string; agentId: number; mode: 'unreplied' | 'fallback_latest' }> = []

    if (byAgent.size > 0) {
      // Serialize for Redis:
      // { byAgent: { [agentId]: { [phone]: { sentAt, mode } } } }
      const payload: Record<string, Record<string, { sentAt: string; mode: 'unreplied' | 'fallback_latest' }>> = {}
      for (const [agentId, phoneMap] of byAgent) {
        payload[String(agentId)] = {}
        for (const phone of phoneMap.keys()) {
          const selected = selectedByPhone.get(phone)
          const mode = selected?.mode ?? 'unreplied'
          const sentAt = phoneMap.get(phone) ?? new Date(0).toISOString()
          payload[String(agentId)][phone] = { sentAt, mode }
          queued.push({ phone, agentId, mode })
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
