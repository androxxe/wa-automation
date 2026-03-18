import path from 'path'
import { Router } from 'express'
import { z } from 'zod'
import { db } from '../lib/db'
import { redis } from '../lib/queue'

const PROFILES_DIR = process.env.BROWSER_PROFILE_PATH
  ?? process.env.BROWSER_PROFILES_DIR
  ?? './browser-profile'

const router: import('express').Router = Router()

const parseId = (id: string) => parseInt(id, 10)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayWIB(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }) // "YYYY-MM-DD"
}

async function agentWithLiveStatus(agentId: number) {
  const agent       = await db.agent.findUnique({ where: { id: agentId }, include: { department: true } })
  if (!agent) return null
  const status      = (await redis.get(`agent:${agentId}:status`)) ?? 'OFFLINE'
  const screenshot  = await redis.get(`agent:${agentId}:screenshot`)
  const activeJobs  = parseInt((await redis.get(`agent:${agentId}:active_jobs`)) ?? '0', 10)
  const log         = await db.dailySendLog.findUnique({ where: { agentId_date: { agentId, date: todayWIB() } } })
  const sentToday   = log?.count ?? 0
  return { ...agent, status, screenshot, activeJobCount: activeJobs, sentToday }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/agents
router.get('/', async (_req, res) => {
  try {
    const agents = await db.agent.findMany({
      include: { department: true },
      orderBy: { createdAt: 'asc' },
    })
    const today = todayWIB()
    const withStatus = await Promise.all(
      agents.map(async (a) => {
        const status     = (await redis.get(`agent:${a.id}:status`)) ?? 'OFFLINE'
        const screenshot = await redis.get(`agent:${a.id}:screenshot`)
        const activeJobs = parseInt((await redis.get(`agent:${a.id}:active_jobs`)) ?? '0', 10)
        const log        = await db.dailySendLog.findUnique({ where: { agentId_date: { agentId: a.id, date: today } } })
        const sentToday  = log?.count ?? 0
        return { ...a, status, screenshot, activeJobCount: activeJobs, sentToday }
      }),
    )
    res.json({ ok: true, data: withStatus })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/agents
const CreateAgent = z.object({
  name:           z.string().min(1),
  phoneNumber:    z.string().min(6, 'Phone number is required'),
  dailySendCap:   z.number().int().min(1).optional(),
  breakEvery:     z.number().int().min(1).optional(),
  breakMinMs:     z.number().int().min(1000).optional(),
  breakMaxMs:     z.number().int().min(1000).optional(),
  typeDelayMinMs: z.number().int().min(1).optional(),
  typeDelayMaxMs: z.number().int().min(1).optional(),
  departmentId:   z.string().optional(),
})

router.post('/', async (req, res) => {
  const parsed = CreateAgent.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.message })
    return
  }
  try {
    // Create with placeholder profilePath first to get the generated ID
    const agent = await db.agent.create({
      data: { ...parsed.data, profilePath: '' },
    })
    // Auto-derive profilePath: {BROWSER_PROFILES_DIR}/{agentId}
    const profilePath = path.resolve(path.join(PROFILES_DIR, String(agent.id)))
    const updated = await db.agent.update({
      where: { id: agent.id },
      data:  { profilePath },
    })
    res.status(201).json({ ok: true, data: updated })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// GET /api/agents/:id
router.get('/:id', async (req, res) => {
  try {
    const data = await agentWithLiveStatus(parseId(req.params.id))
    if (!data) { res.status(404).json({ ok: false, error: 'Agent not found' }); return }
    res.json({ ok: true, data })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// PATCH /api/agents/:id
router.patch('/:id', async (req, res) => {
  const { name, departmentId, phoneNumber, dailySendCap, breakEvery, breakMinMs, breakMaxMs, typeDelayMinMs, typeDelayMaxMs, warmMode } = req.body as {
    name?: string; departmentId?: string | null; phoneNumber?: string
    dailySendCap?: number | null
    breakEvery?: number | null; breakMinMs?: number | null; breakMaxMs?: number | null
    typeDelayMinMs?: number | null; typeDelayMaxMs?: number | null
    warmMode?: boolean
  }
  try {
    const updated = await db.agent.update({
      where: { id: parseId(req.params.id) },
      data: {
        ...(name           !== undefined ? { name }           : {}),
        ...(phoneNumber    !== undefined ? { phoneNumber }    : {}),
        ...(dailySendCap   !== undefined ? { dailySendCap }   : {}),
        ...(breakEvery     !== undefined ? { breakEvery }     : {}),
        ...(breakMinMs     !== undefined ? { breakMinMs }     : {}),
        ...(breakMaxMs     !== undefined ? { breakMaxMs }     : {}),
        ...(typeDelayMinMs !== undefined ? { typeDelayMinMs } : {}),
        ...(typeDelayMaxMs !== undefined ? { typeDelayMaxMs } : {}),
        ...(warmMode       !== undefined ? { warmMode }       : {}),
        ...(departmentId !== undefined ? { department: departmentId ? { connect: { id: departmentId } } : { disconnect: true } } : {}),
      },
    })
    res.json({ ok: true, data: updated })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// DELETE /api/agents/:id
router.delete('/:id', async (req, res) => {
  try {
    const id     = parseId(req.params.id)
    const status = (await redis.get(`agent:${id}:status`)) ?? 'OFFLINE'
    if (status !== 'OFFLINE') {
      res.status(400).json({ ok: false, error: 'Agent must be stopped before deletion' })
      return
    }
    await db.agent.delete({ where: { id } })
    res.json({ ok: true, data: null })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// GET /api/agents/:id/status
router.get('/:id/status', async (req, res) => {
  const id         = parseId(req.params.id)
  const status     = (await redis.get(`agent:${id}:status`)) ?? 'OFFLINE'
  const activeJobs = parseInt((await redis.get(`agent:${id}:active_jobs`)) ?? '0', 10)
  res.json({ ok: true, data: { status, activeJobCount: activeJobs } })
})

// GET /api/agents/:id/screenshot
router.get('/:id/screenshot', async (req, res) => {
  const screenshot = await redis.get(`agent:${parseId(req.params.id)}:screenshot`)
  res.json({ ok: true, data: { screenshot } })
})

// POST /api/agents/:id/start
router.post('/:id/start', async (req, res) => {
  const id = parseId(req.params.id)
  try {
    await redis.publish(`browser:command:${id}`, JSON.stringify({ agentId: id, cmd: 'start' }))
    res.json({ ok: true, data: { queued: true } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/agents/:id/stop
router.post('/:id/stop', async (req, res) => {
  const id = parseId(req.params.id)
  try {
    await redis.publish(`browser:command:${id}`, JSON.stringify({ agentId: id, cmd: 'stop' }))
    res.json({ ok: true, data: { queued: true } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// GET /api/agents/:id/events — SSE for a single agent
router.get('/:id/events', (req, res) => {
  const agentId = parseId(req.params.id)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // Poll Redis every 3s and push status changes
  let lastStatus = ''
  const interval = setInterval(async () => {
    const status = (await redis.get(`agent:${agentId}:status`)) ?? 'OFFLINE'
    if (status !== lastStatus) {
      lastStatus = status
      res.write(`data: ${JSON.stringify({ type: 'agent:status', payload: { agentId, status } })}\n\n`)
    }
  }, 3000)

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000)
  req.on('close', () => {
    clearInterval(interval)
    clearInterval(keepAlive)
  })
})

export default router
