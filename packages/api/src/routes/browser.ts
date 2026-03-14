import { Router } from 'express'
import { redis } from '../lib/queue'

const router = Router()

// GET /api/browser/status
router.get('/status', async (_req, res) => {
  const status = (await redis.get('browser:status')) ?? 'disconnected'
  res.json({ ok: true, data: { status } })
})

// GET /api/browser/screenshot
router.get('/screenshot', async (_req, res) => {
  const screenshot = await redis.get('browser:screenshot')
  res.json({ ok: true, data: { screenshot } })
})

// POST /api/browser/start
router.post('/start', (_req, res) => {
  // TODO: publish 'browser:start' command to Redis → worker picks up
  res.json({ ok: true, data: { queued: true } })
})

// POST /api/browser/stop
router.post('/stop', (_req, res) => {
  // TODO: publish 'browser:stop' command to Redis → worker picks up
  res.json({ ok: true, data: { queued: true } })
})

// GET /api/browser/events — SSE
router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // TODO: subscribe to Redis pub/sub channel 'browser:events' and forward to client
  const keepAlive = setInterval(() => {
    res.write(': ping\n\n')
  }, 15000)

  req.on('close', () => clearInterval(keepAlive))
})

export default router
