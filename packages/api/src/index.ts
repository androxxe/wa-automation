import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { validateStartup } from './lib/validate'

import agentsRouter   from './routes/agents'
import browserRouter  from './routes/browser'
import configRouter   from './routes/config'
import filesRouter    from './routes/files'
import contactsRouter from './routes/contacts'
import campaignsRouter from './routes/campaigns'
import analyzeRouter  from './routes/analyze'
import exportRouter   from './routes/export'

async function main() {
  await validateStartup()

  const app  = express()
  const PORT = process.env.PORT ?? 3001

  app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173' }))
  app.use(express.json({ limit: '10mb' }))

  app.use('/api/agents',    agentsRouter)
  app.use('/api/browser',   browserRouter)
  app.use('/api/config',    configRouter)
  app.use('/api/files',     filesRouter)
  app.use('/api/contacts',  contactsRouter)
  app.use('/api/campaigns', campaignsRouter)
  app.use('/api/analyze',   analyzeRouter)
  app.use('/api/export',    exportRouter)

  app.get('/api/health', (_req, res) =>
    res.json({ ok: true, timestamp: new Date().toISOString() }),
  )

  app.listen(PORT, () => console.log(`[api] listening on http://localhost:${PORT}`))
}

main().catch((err) => {
  console.error('[api] fatal startup error:', err)
  process.exit(1)
})
