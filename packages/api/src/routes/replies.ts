import path from 'path'
import fs   from 'fs'
import { Router } from 'express'
import { db } from '../lib/db'
import { redis } from '../lib/queue'
import { normalizePhone } from '../lib/phone'

const OUTPUT_FOLDER = process.env.OUTPUT_FOLDER ?? ''
const ALLOWED_REPLY_CATEGORIES = new Set(['confirmed', 'denied', 'question', 'unclear', 'invalid', 'other'])

const router: import('express').Router = Router()

// ─── GET /api/replies ─────────────────────────────────────────────────────────
// Query params:
//   campaignId  — filter by campaign
//   category    — 'confirmed'|'denied'|'question'|'unclear'|'invalid'|'other'
//   jawaban     — '1' (yes) | '0' (no) | 'null' (unclear)
//   page        — default 1
//   limit       — default 50, max 200

router.get('/', async (req, res) => {
  try {
    const {
      campaignId,
      campaignType,
      bulan,
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
    const messageWhere: Record<string, unknown> = {}
    const campaignWhere: Record<string, unknown> = {}

    if (campaignId) messageWhere.campaignId = campaignId
    if (campaignType) campaignWhere.campaignType = campaignType
    if (bulan) campaignWhere.bulan = bulan

    if (Object.keys(campaignWhere).length > 0) messageWhere.campaign = campaignWhere
    if (Object.keys(messageWhere).length > 0) where.message = messageWhere

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
              metadata:   true,
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
      invalid:   0,
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
      select: { phone: true, sentAt: true, createdAt: true, agentId: true, body: true },
    })

    type ManualPollAnchor = {
      phone: string
      sentAt: Date
      agentId: number
      mode: 'unreplied' | 'fallback_latest'
      body: string
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
          body: m.body,
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
        select: { phone: true, sentAt: true, createdAt: true, agentId: true, body: true },
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
            body: m.body,
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
      // { byAgent: { [agentId]: { [phone]: { sentAt, mode, body } } } }
      const payload: Record<string, Record<string, { sentAt: string; mode: 'unreplied' | 'fallback_latest'; body: string }>> = {}
      for (const [agentId, phoneMap] of byAgent) {
        payload[String(agentId)] = {}
        for (const phone of phoneMap.keys()) {
          const selected = selectedByPhone.get(phone)
          const mode = selected?.mode ?? 'unreplied'
          const sentAt = phoneMap.get(phone) ?? new Date(0).toISOString()
          const body   = selected?.body ?? ''
          payload[String(agentId)][phone] = { sentAt, mode, body }
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

// ─── PUT /api/replies/:id ─────────────────────────────────────────────────────
// Update a reply's category and/or jawaban
// Body: { category?: string, jawaban?: number | null }

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { category, jawaban } = req.body as { category?: string; jawaban?: number | null }

    // Validate category if provided
    if (category && !ALLOWED_REPLY_CATEGORIES.has(category)) {
      return res.status(400).json({
        ok: false,
        error: `Invalid category. Allowed: ${Array.from(ALLOWED_REPLY_CATEGORIES).join(', ')}`,
      })
    }

    // Build update object
    const updateData: Record<string, unknown> = {}
    if (category !== undefined) updateData.claudeCategory = category
    if (jawaban !== undefined) updateData.jawaban = jawaban

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ ok: false, error: 'No fields to update' })
    }

    const updated = await db.reply.update({
      where: { id },
      data: updateData,
    })

    res.json({ ok: true, data: updated })
  } catch (err) {
    if (String(err).includes('Record to update not found')) {
      res.status(404).json({ ok: false, error: 'Reply not found' })
    } else {
      res.status(500).json({ ok: false, error: String(err) })
    }
  }
})

// ─── GET /api/replies/unreplied-phones ────────────────────────────────────────
// Returns phones with unreplied messages. Pass ?phone= to look up a single phone.

const REPLY_WINDOW_DAYS = parseInt(process.env.CAMPAIGN_REPLY_WINDOW_DAYS ?? '3', 10)

router.get('/unreplied-phones', async (req, res) => {
  try {
    const { phone: lookupPhone } = req.query as Record<string, string>
    const phoneFilter: Record<string, unknown> = {}
    if (lookupPhone) {
      const normalized = normalizePhone(lookupPhone)
      if (!normalized.valid) {
        res.status(400).json({ ok: false, error: `Invalid phone: ${normalized.reason}` })
        return
      }
      phoneFilter.phone = normalized.normalized
    }

    const replyWindowCutoff = new Date(Date.now() - REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const messages = await db.message.findMany({
      where: {
        ...phoneFilter,
        status: { in: ['SENT', 'DELIVERED', 'READ'] },
        reply:  null,
        campaign: {
          OR: [
            { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
            { status: 'COMPLETED', completedAt: { gte: replyWindowCutoff } },
          ],
        },
      },
      select: {
        phone:      true,
        body:       true,
        sentAt:     true,
        campaignId: true,
        campaign:   { select: { id: true, name: true, bulan: true } },
        contact:    { select: { area: { select: { name: true } } } },
      },
      orderBy: { sentAt: 'desc' },
    })

    const deduped = new Map<string, typeof messages[number]>()
    for (const m of messages) {
      if (!deduped.has(m.phone)) deduped.set(m.phone, m)
    }

    const data = Array.from(deduped.values()).map((m) => ({
      phone:        m.phone,
      campaignId:   m.campaignId,
      campaignName: m.campaign.name,
      areaName:     m.contact?.area?.name ?? '-',
      messageBody:  m.body.slice(0, 120),
      sentAt:       m.sentAt?.toISOString() ?? null,
    }))

    res.json({ ok: true, data })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── POST /api/replies — manual or webhook reply entry ────────────────────────
// Body:
//   phone      string   required
//   body       string   required  — reply text
//   source     string   required  — "manual" or "webhook"
//   campaignId string   optional  — auto-detected if omitted
//
//   For source=manual (operator fills form):
//     jawaban   number   required  — 0 or 1
//     category  string   required  — one of ALLOWED_REPLY_CATEGORIES
//     sentiment string   optional
//     summary   string   optional
//     photo     string   required  — base64-encoded JPEG
//
//   For source=webhook (MacroDroid etc):
//     (no extra fields — auto-runs Claude analysis)

router.post('/', async (req, res) => {
  try {
    const {
      phone: rawPhone, body, source, campaignId,
      jawaban, category, sentiment, summary, photo,
    } = req.body as {
      phone?: string; body?: string; source?: string; campaignId?: string
      jawaban?: number; category?: string; sentiment?: string; summary?: string; photo?: string
    }

    // ── Validate required fields ────────────────────────────────────────────
    if (!rawPhone || !body || !source) {
      res.status(400).json({ ok: false, error: 'phone, body, and source are required' })
      return
    }
    if (!['manual', 'webhook'].includes(source)) {
      res.status(400).json({ ok: false, error: 'source must be "manual" or "webhook"' })
      return
    }

    const phoneResult = normalizePhone(rawPhone)
    if (!phoneResult.valid) {
      res.status(400).json({ ok: false, error: `Invalid phone: ${phoneResult.reason}` })
      return
    }
    const phone = phoneResult.normalized

    if (source === 'manual') {
      if (jawaban !== 0 && jawaban !== 1) {
        res.status(400).json({ ok: false, error: 'jawaban must be 0 or 1' })
        return
      }
      if (!category || !ALLOWED_REPLY_CATEGORIES.has(category)) {
        res.status(400).json({ ok: false, error: `category is required, must be one of: ${Array.from(ALLOWED_REPLY_CATEGORIES).join(', ')}` })
        return
      }
      if (!photo) {
        res.status(400).json({ ok: false, error: 'photo is required for manual replies' })
        return
      }
    }

    // ── Find unreplied messages (fan-out like handleReply) ──────────────────
    const replyWindowCutoff = new Date(Date.now() - REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const where: Record<string, unknown> = {
      phone,
      status: { in: ['SENT', 'DELIVERED', 'READ', 'EXPIRED', 'FAILED'] },
      reply:  null,
      campaign: {
        OR: [
          { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
          { status: 'COMPLETED', completedAt: { gte: replyWindowCutoff } },
        ],
      },
    }
    if (campaignId) where.campaignId = campaignId

    const unrepliedMessages = await db.message.findMany({
      where,
      include: { campaign: true, contact: { include: { area: true } } },
      orderBy: { sentAt: 'desc' },
    })

    if (unrepliedMessages.length === 0) {
      res.status(404).json({ ok: false, error: 'No unreplied messages found for this phone' })
      return
    }

    // ── Save photo (same pattern as BrowserAgent._saveReplyScreenshot) ──────
    let screenshotPath: string | null = null
    if (photo && OUTPUT_FOLDER) {
      try {
        const dir = path.join(OUTPUT_FOLDER, 'screenshots')
        fs.mkdirSync(dir, { recursive: true })
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const filename  = `${phone.replace('+', '')}_${timestamp}.jpg`
        fs.writeFileSync(path.join(dir, filename), Buffer.from(photo.replace(/^data:image\/\w+;base64,/, ''), 'base64'))
        screenshotPath = `screenshots/${filename}`
      } catch (err) {
        res.status(500).json({ ok: false, error: `Failed to save photo: ${String(err)}` })
        return
      }
    }

    // ── Claude analysis (webhook only) ──────────────────────────────────────
    let analysisData: Record<string, unknown> = {}
    if (source === 'webhook') {
      try {
        const analysisMsg = unrepliedMessages[0]
        const apiUrl = `http://localhost:${process.env.PORT ?? 3001}`
        const resp = await fetch(`${apiUrl}/api/analyze/reply`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            replyText:    body,
            bulan:        analysisMsg.campaign.bulan,
            campaignType: analysisMsg.contact.area.contactType,
          }),
        })
        if (resp.ok) {
          const json = await resp.json() as { ok: boolean; data: Record<string, unknown> }
          if (json.ok) analysisData = json.data
        }
      } catch (err) {
        console.warn('[api] analyze/reply call failed:', err)
      }
    }

    // ── Create Reply records + update counters ──────────────────────────────
    const created: string[] = []
    const apiUrl = `http://localhost:${process.env.PORT ?? 3001}`

    for (const msg of unrepliedMessages) {
      const reply = await db.reply.create({
        data: {
          messageId:      msg.id,
          phone,
          body,
          screenshotPath,
          claudeCategory:  source === 'manual' ? category! : ((analysisData.category  as string) ?? null),
          claudeSentiment: source === 'manual' ? (sentiment ?? null) : ((analysisData.sentiment as string) ?? null),
          claudeSummary:   source === 'manual' ? (summary   ?? null) : ((analysisData.summary   as string) ?? null),
          jawaban:         source === 'manual' ? jawaban! : ((analysisData.jawaban   as number | null) ?? null),
          claudeRaw:       { source },
        },
      }).catch((e) => {
        console.warn(`[api] reply.create failed for msg ${msg.id}:`, e)
        return null
      })

      if (!reply) continue
      created.push(reply.id)

      if (msg.status !== 'READ') {
        await db.message.update({ where: { id: msg.id }, data: { status: 'READ', readAt: new Date() } })
        await db.campaign.update({ where: { id: msg.campaignId }, data: { readCount: { increment: 1 } } })
      }
      await db.campaign.update({ where: { id: msg.campaignId }, data: { replyCount: { increment: 1 } } })
      await db.campaignArea.updateMany({
        where: { campaignId: msg.campaignId, areaId: msg.contact.areaId },
        data:  { replyCount: { increment: 1 } },
      })

      if (msg.campaign.stopOnTargetReached) {
        const appConfig = await db.appConfig.findUnique({ where: { id: 'singleton' } })
        const target = msg.campaign.targetRepliesPerArea ?? appConfig?.defaultTargetRepliesPerArea ?? 20
        const area = await db.campaignArea.findUnique({
          where: { campaignId_areaId: { campaignId: msg.campaignId, areaId: msg.contact.areaId } },
        })
        if (area && area.replyCount >= target && !area.targetReached) {
          await db.campaignArea.update({
            where: { campaignId_areaId: { campaignId: msg.campaignId, areaId: msg.contact.areaId } },
            data:  { targetReached: true },
          })
          await db.message.updateMany({
            where: { campaignId: msg.campaignId, status: { in: ['PENDING', 'QUEUED'] }, contact: { areaId: msg.contact.areaId } },
            data:  { status: 'CANCELLED' },
          })
          const allAreas = await db.campaignArea.findMany({
            where: { campaignId: msg.campaignId },
            select: { targetReached: true },
          })
          if (allAreas.length > 0 && allAreas.every((a) => a.targetReached)) {
            await db.campaign.update({
              where: { id: msg.campaignId },
              data:  { status: 'COMPLETED', completedAt: new Date() },
            })
          }
        }
      }

      fetch(`${apiUrl}/api/export/report-area`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          areaId:       msg.contact.areaId,
          bulan:        msg.campaign.bulan,
          campaignType: msg.contact.area.contactType,
        }),
      }).catch(() => {})
    }

    res.json({ ok: true, data: { created, count: created.length } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

export default router
