import { Router } from 'express'
import { redis } from '../lib/queue'
import { db } from '../lib/db'

const router: import('express').Router = Router()

// GET /api/browser/status — aggregate across all agents
router.get('/status', async (_req, res) => {
  try {
    const agents  = await db.agent.findMany({ select: { id: true, name: true } })
    const results = await Promise.all(
      agents.map(async (a) => ({
        agentId: a.id,
        name:    a.name,
        status:  (await redis.get(`agent:${a.id}:status`)) ?? 'OFFLINE',
      })),
    )
    const anyOnline = results.some((r) => r.status === 'ONLINE')
    res.json({ ok: true, data: { agents: results, anyOnline } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// GET /api/browser/screenshot — screenshot of first ONLINE agent
router.get('/screenshot', async (_req, res) => {
  try {
    const agents = await db.agent.findMany({ select: { id: true } })
    for (const a of agents) {
      const status = (await redis.get(`agent:${a.id}:status`)) ?? 'OFFLINE'
      if (status === 'ONLINE') {
        const screenshot = await redis.get(`agent:${a.id}:screenshot`)
        if (screenshot) {
          res.json({ ok: true, data: { screenshot, agentId: a.id } })
          return
        }
      }
    }
    res.json({ ok: true, data: { screenshot: null } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/browser/start — start first OFFLINE agent
router.post('/start', async (_req, res) => {
  try {
    const agents = await db.agent.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true } })
    for (const a of agents) {
      const status = (await redis.get(`agent:${a.id}:status`)) ?? 'OFFLINE'
      if (status === 'OFFLINE') {
        await redis.publish(`browser:command:${a.id}`, JSON.stringify({ agentId: a.id, cmd: 'start' }))
        res.json({ ok: true, data: { agentId: a.id, queued: true } })
        return
      }
    }
    res.json({ ok: true, data: { queued: false, message: 'All agents already running' } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/browser/stop — stop all agents
router.post('/stop', async (_req, res) => {
  try {
    const agents = await db.agent.findMany({ select: { id: true } })
    for (const a of agents) {
      await redis.publish(`browser:command:${a.id}`, JSON.stringify({ agentId: a.id, cmd: 'stop' }))
    }
    res.json({ ok: true, data: { stopped: agents.length } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// GET /api/browser/events — SSE for all agents
router.get('/events', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const agents  = await db.agent.findMany({ select: { id: true, name: true } })
  const lastMap = new Map<number, string>()

  const interval = setInterval(async () => {
    for (const a of agents) {
      const status = (await redis.get(`agent:${a.id}:status`)) ?? 'OFFLINE'
      if (lastMap.get(a.id) !== status) {
        lastMap.set(a.id, status)
        res.write(`data: ${JSON.stringify({ type: 'agent:status', payload: { agentId: a.id, name: a.name, status } })}\n\n`)
      }
    }
  }, 3000)

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000)
  req.on('close', () => {
    clearInterval(interval)
    clearInterval(keepAlive)
  })
})

export default router
