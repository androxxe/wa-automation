import { Router } from 'express'

// NOTE: BrowserManager is owned by packages/worker.
// The API reads browser status from the DB/Redis and proxies SSE events.
// Direct browser control (start/stop/screenshot) is handled by the worker
// process via Redis pub/sub commands. For now these are stubs.

const router = Router()

// GET /api/browser/status
router.get('/status', (_req, res) => {
  // TODO: read BrowserStatus from Redis (set by worker)
  res.json({ ok: true, data: { status: 'disconnected' } })
})

// GET /api/browser/screenshot
router.get('/screenshot', (_req, res) => {
  // TODO: read latest screenshot base64 from Redis (set by worker)
  res.json({ ok: true, data: { screenshot: null } })
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
