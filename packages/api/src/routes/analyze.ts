import { Router } from 'express'
import { z } from 'zod'
import { mapHeaders, analyzeReply, varyMessage } from '../lib/claude'
import { db } from '../lib/db'

const router: import('express').Router = Router()

// POST /api/analyze/headers — Claude Job 1
router.post('/headers', async (req, res) => {
  const { headers, sampleRows } = req.body as {
    headers:    string[]
    sampleRows: Record<string, unknown>[]
  }
  if (!headers || !sampleRows) {
    res.status(400).json({ ok: false, error: 'headers and sampleRows are required' })
    return
  }
  try {
    res.json({ ok: true, data: await mapHeaders(headers, sampleRows) })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/analyze/reply — Claude Job 2
// Used by the worker for fan-out replies. Only performs Claude analysis;
// Reply records are created by the worker itself.
const AnalyzeReplyBody = z.object({
  replyText:    z.string(),
  bulan:        z.string(),
  campaignType: z.string().optional(),
})

router.post('/reply', async (req, res) => {
  const parsed = AnalyzeReplyBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.message })
    return
  }
  const { replyText, bulan } = parsed.data
  try {
    const analysis = await analyzeReply(replyText, bulan)
    res.json({ ok: true, data: { ...analysis, jawaban: analysis.jawaban ?? null } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/analyze/vary — Claude Job 3
router.post('/vary', async (req, res) => {
  const { message } = req.body as { message: string }
  if (!message) { res.status(400).json({ ok: false, error: 'message is required' }); return }
  try {
    res.json({ ok: true, data: { varied: await varyMessage(message) } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

export default router
