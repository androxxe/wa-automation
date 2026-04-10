import crypto from 'crypto'
import { Router } from 'express'
import { z } from 'zod'
import { db } from '../lib/db'
import { redis } from '../lib/queue'
import { normalizePhone } from '../lib/phone'

const router: import('express').Router = Router()
const MANUAL_SEND_CHANNEL = process.env.MANUAL_SEND_CHANNEL ?? 'manual-send:cmd'

const SendSchema = z.object({
  phone:     z.string().trim().min(3),
  body:      z.string().trim().min(1).max(2048).optional(),
  agentId:   z.number().int().positive().optional(),
  dryRun:    z.boolean().optional(),
  messageId: z.string().trim().optional(),
})

// POST /api/messages/send — fire-and-forget manual send
router.post('/send', async (req, res) => {
  const parsed = SendSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.message })
    return
  }

  const { phone, agentId, dryRun, messageId } = parsed.data

  const normalized = normalizePhone(phone)
  if (!normalized.valid) {
    res.status(400).json({ ok: false, error: `Invalid phone: ${normalized.reason ?? 'invalid'}` })
    return
  }

  let resolvedBody = parsed.data.body ?? ''

  if (messageId) {
    const msg = await db.message.findUnique({ where: { id: messageId } })
    if (!msg) {
      res.status(404).json({ ok: false, error: 'Message not found' })
      return
    }

    if (['SENT', 'DELIVERED', 'READ'].includes(msg.status)) {
      res.status(409).json({ ok: false, error: `Message already ${msg.status}` })
      return
    }

    if (msg.phone !== normalized.normalized) {
      res.status(400).json({ ok: false, error: 'Phone does not match message' })
      return
    }

    resolvedBody = resolvedBody || msg.body
  }

  if (!resolvedBody) {
    res.status(400).json({ ok: false, error: 'Body is required' })
    return
  }

  // Resolve agent
  const agents = await db.agent.findMany({
    select: { id: true, validationOnly: true },
    orderBy: { id: 'asc' },
  })

  const onlineStatus = async (id: number) => (await redis.get(`agent:${id}:status`)) ?? 'OFFLINE'

  let selected: number | null = null

  if (agentId !== undefined) {
    const exists = agents.find((a) => a.id === agentId)
    if (!exists) {
      res.status(404).json({ ok: false, error: 'Agent not found' })
      return
    }
    if (exists.validationOnly) {
      res.status(409).json({ ok: false, error: 'Agent is validation-only and cannot send messages' })
      return
    }
    if ((await onlineStatus(agentId)) !== 'ONLINE') {
      res.status(409).json({ ok: false, error: 'Agent is not online' })
      return
    }
    selected = agentId
  } else {
    for (const agent of agents) {
      if (agent.validationOnly) continue
      if ((await onlineStatus(agent.id)) === 'ONLINE') {
        selected = agent.id
        break
      }
    }
    if (!selected) {
      res.status(409).json({ ok: false, error: 'No online agent available' })
      return
    }
  }

  const requestId = crypto.randomUUID()
  const payload = {
    requestId,
    phone: normalized.normalized,
    body: resolvedBody,
    agentId: selected,
    requestedBy: req.headers['x-user'] ?? undefined,
    dryRun: dryRun ?? false,
    ...(messageId ? { messageId } : {}),
  }

  await redis.publish(MANUAL_SEND_CHANNEL, JSON.stringify(payload))

  res.status(202).json({ ok: true, data: { requestId, status: 'queued', agentId: selected } })
})

export default router
