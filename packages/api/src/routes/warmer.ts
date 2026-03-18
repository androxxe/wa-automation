import { Router } from 'express'
import { z } from 'zod'
import { db } from '../lib/db'
import { redis, warmQueue } from '../lib/queue'

const router: import('express').Router = Router()

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Drain all warm-queue jobs (waiting + delayed) that belong to a specific session.
 */
async function drainSessionJobs(sessionId: string): Promise<void> {
  const jobs = await warmQueue.getJobs(['waiting', 'delayed'])
  await Promise.all(
    jobs
      .filter((j) => j.data.warmSessionId === sessionId)
      .map((j) => j.remove().catch(() => {})),
  )
}

function sessionToInfo(session: {
  id: string
  name: string
  status: string
  totalExchanges: number
  doneExchanges: number
  partialFailure: boolean
  createdAt: Date
  startedAt: Date | null
  completedAt: Date | null
  agents: Array<{ agentId: number; agent: { name: string; phoneNumber: string } }>
}) {
  return {
    id:             session.id,
    name:           session.name,
    status:         session.status,
    totalExchanges: session.totalExchanges,
    doneExchanges:  session.doneExchanges,
    partialFailure: session.partialFailure,
    createdAt:      session.createdAt.toISOString(),
    startedAt:      session.startedAt?.toISOString() ?? null,
    completedAt:    session.completedAt?.toISOString() ?? null,
    agents: session.agents.map((a) => ({
      agentId:     a.agentId,
      agentName:   a.agent.name,
      phoneNumber: a.agent.phoneNumber,
    })),
  }
}

// ─── GET /api/warmer/sessions ─────────────────────────────────────────────────

router.get('/sessions', async (_req, res) => {
  try {
    const sessions = await db.warmSession.findMany({
      include: { agents: { include: { agent: true } } },
      orderBy: { createdAt: 'desc' },
    })
    res.json({ ok: true, data: sessions.map(sessionToInfo) })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── POST /api/warmer/sessions ────────────────────────────────────────────────

const CreateSession = z.object({
  name:           z.string().min(1),
  agentIds:       z.array(z.number().int().positive()).min(2).max(4),
  totalExchanges: z.number().int().min(10).max(500),
})

router.post('/sessions', async (req, res) => {
  const parsed = CreateSession.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.message })
    return
  }
  const { name, agentIds, totalExchanges } = parsed.data

  try {
    // Validate: all agents must have warmMode = true
    const agents = await db.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, warmMode: true },
    })
    if (agents.length !== agentIds.length) {
      res.status(400).json({ ok: false, error: 'One or more agent IDs not found' })
      return
    }
    const notWarmMode = agents.filter((a) => !a.warmMode)
    if (notWarmMode.length > 0) {
      res.status(400).json({
        ok: false,
        error: `Agent(s) ${notWarmMode.map((a) => a.id).join(', ')} do not have warmMode enabled`,
      })
      return
    }

    // Validate: no agent in another RUNNING session
    const runningConflicts = await db.warmSessionAgent.findMany({
      where: {
        agentId: { in: agentIds },
        session: { status: 'RUNNING' },
      },
      select: { agentId: true },
    })
    if (runningConflicts.length > 0) {
      const ids = [...new Set(runningConflicts.map((r) => r.agentId))]
      res.status(409).json({
        ok: false,
        error: `Agent(s) ${ids.join(', ')} are already in a RUNNING warm session`,
      })
      return
    }

    const session = await db.warmSession.create({
      data: {
        name,
        totalExchanges,
        agents: {
          create: agentIds.map((id) => ({ agentId: id })),
        },
      },
      include: { agents: { include: { agent: true } } },
    })
    res.status(201).json({ ok: true, data: sessionToInfo(session) })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── GET /api/warmer/sessions/:id ─────────────────────────────────────────────

router.get('/sessions/:id', async (req, res) => {
  try {
    const session = await db.warmSession.findUnique({
      where:   { id: req.params.id },
      include: { agents: { include: { agent: true } }, exchanges: { orderBy: { createdAt: 'asc' } } },
    })
    if (!session) { res.status(404).json({ ok: false, error: 'Session not found' }); return }

    const exchanges = session.exchanges.map((e) => ({
      id:               e.id,
      warmSessionId:    e.warmSessionId,
      senderAgentId:    e.senderAgentId,
      recipientAgentId: e.recipientAgentId,
      message:          e.message,
      replyMessage:     e.replyMessage,
      status:           e.status,
      sentAt:           e.sentAt?.toISOString()    ?? null,
      repliedAt:        e.repliedAt?.toISOString() ?? null,
      failReason:       e.failReason               ?? null,
      createdAt:        e.createdAt.toISOString(),
    }))

    res.json({ ok: true, data: { ...sessionToInfo(session), exchanges } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── DELETE /api/warmer/sessions/:id ──────────────────────────────────────────

router.delete('/sessions/:id', async (req, res) => {
  try {
    const session = await db.warmSession.findUnique({
      where:  { id: req.params.id },
      select: { status: true },
    })
    if (!session) { res.status(404).json({ ok: false, error: 'Session not found' }); return }
    if (!['IDLE', 'COMPLETED'].includes(session.status)) {
      res.status(409).json({
        ok: false,
        error: `Cannot delete a session with status ${session.status} — only IDLE or COMPLETED sessions can be deleted`,
      })
      return
    }
    await db.warmSession.delete({ where: { id: req.params.id } })
    res.json({ ok: true, data: null })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── POST /api/warmer/sessions/:id/start ──────────────────────────────────────

router.post('/sessions/:id/start', async (req, res) => {
  const sessionId = req.params.id
  try {
    const session = await db.warmSession.findUnique({
      where:   { id: sessionId },
      include: { agents: { include: { agent: true } } },
    })
    if (!session) { res.status(404).json({ ok: false, error: 'Session not found' }); return }
    if (session.status !== 'IDLE') {
      res.status(409).json({
        ok: false,
        error: `Session cannot be started from status ${session.status} — must be IDLE`,
      })
      return
    }

    // Re-validate: no agent in another RUNNING session (could have changed since creation)
    const agentIds = session.agents.map((a) => a.agentId)
    const runningConflicts = await db.warmSessionAgent.findMany({
      where: {
        agentId:      { in: agentIds },
        warmSessionId: { not: sessionId },
        session:       { status: 'RUNNING' },
      },
      select: { agentId: true },
    })
    if (runningConflicts.length > 0) {
      const ids = [...new Set(runningConflicts.map((r) => r.agentId))]
      res.status(409).json({
        ok: false,
        error: `Agent(s) ${ids.join(', ')} are in another RUNNING session`,
      })
      return
    }

    // Publish start command to worker via Redis pub/sub
    // The worker's startWarmSession helper handles all BullMQ enqueuing
    await redis.publish('warm:command', JSON.stringify({ cmd: 'start', sessionId }))

    res.json({ ok: true, data: { sessionId, queued: true } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── POST /api/warmer/sessions/:id/pause ──────────────────────────────────────

router.post('/sessions/:id/pause', async (req, res) => {
  const sessionId = req.params.id
  try {
    const session = await db.warmSession.findUnique({
      where:  { id: sessionId },
      select: { status: true },
    })
    if (!session) { res.status(404).json({ ok: false, error: 'Session not found' }); return }
    if (session.status !== 'RUNNING') {
      res.status(409).json({
        ok: false,
        error: `Session cannot be paused from status ${session.status} — must be RUNNING`,
      })
      return
    }

    // Mark PAUSED first so in-flight jobs discard themselves on guard check
    await db.warmSession.update({
      where: { id: sessionId },
      data:  { status: 'PAUSED' },
    })

    // Drain waiting + delayed jobs for this session
    await drainSessionJobs(sessionId)

    res.json({ ok: true, data: { sessionId, status: 'PAUSED' } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── POST /api/warmer/sessions/:id/resume ─────────────────────────────────────

router.post('/sessions/:id/resume', async (req, res) => {
  const sessionId = req.params.id
  try {
    const session = await db.warmSession.findUnique({
      where:  { id: sessionId },
      select: { status: true },
    })
    if (!session) { res.status(404).json({ ok: false, error: 'Session not found' }); return }
    if (session.status !== 'PAUSED') {
      res.status(409).json({
        ok: false,
        error: `Session cannot be resumed from status ${session.status} — must be PAUSED`,
      })
      return
    }

    // Delegate to worker via Redis pub/sub
    await redis.publish('warm:command', JSON.stringify({ cmd: 'resume', sessionId }))

    res.json({ ok: true, data: { sessionId, queued: true } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── POST /api/warmer/sessions/:id/cancel ─────────────────────────────────────

router.post('/sessions/:id/cancel', async (req, res) => {
  const sessionId = req.params.id
  try {
    const session = await db.warmSession.findUnique({
      where:  { id: sessionId },
      select: { status: true },
    })
    if (!session) { res.status(404).json({ ok: false, error: 'Session not found' }); return }
    if (['COMPLETED', 'CANCELLED'].includes(session.status)) {
      res.status(409).json({
        ok: false,
        error: `Session is already ${session.status}`,
      })
      return
    }

    // Mark CANCELLED first so in-flight jobs discard themselves
    await db.warmSession.update({
      where: { id: sessionId },
      data:  { status: 'CANCELLED' },
    })

    // Drain queued jobs
    await drainSessionJobs(sessionId)

    res.json({ ok: true, data: { sessionId, status: 'CANCELLED' } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── GET /api/warmer/sessions/:id/events — SSE ───────────────────────────────

router.get('/sessions/:id/events', (req, res) => {
  const sessionId = req.params.id

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // Dedicated subscriber connection — main redis client cannot subscribe + command simultaneously
  const sub = redis.duplicate()

  sub.subscribe(`warm:events:${sessionId}`, (err) => {
    if (err) {
      console.error(`[warmer-sse] subscribe error for session ${sessionId}:`, err)
      res.end()
      return
    }
  })

  sub.on('message', (_channel, msg) => {
    res.write(`data: ${msg}\n\n`)
  })

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000)

  // Cleanup on client disconnect — prevents subscriber memory leak
  req.on('close', () => {
    clearInterval(keepAlive)
    sub.unsubscribe().catch(() => {})
    sub.quit().catch(() => {})
  })
})

export default router
