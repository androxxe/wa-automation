import { Router } from 'express'
import { z } from 'zod'
import { mapHeaders, analyzeReply, varyMessage } from '../lib/claude'
import { db } from '../lib/db'

const router = Router()

// POST /api/analyze/headers — Claude Job 1
router.post('/headers', async (req, res) => {
  const { headers, sampleRows } = req.body as {
    headers: string[]
    sampleRows: Record<string, unknown>[]
  }
  if (!headers || !sampleRows) {
    res.status(400).json({ ok: false, error: 'headers and sampleRows are required' })
    return
  }
  try {
    const mapping = await mapHeaders(headers, sampleRows)
    res.json({ ok: true, data: mapping })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/analyze/reply — Claude Job 2
const AnalyzeReplyBody = z.object({
  replyId: z.string(),
  replyText: z.string(),
  bulan: z.string(),
})

router.post('/reply', async (req, res) => {
  const parsed = AnalyzeReplyBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.message })
    return
  }
  const { replyId, replyText, bulan } = parsed.data
  try {
    const analysis = await analyzeReply(replyText, bulan)
    await db.reply.update({
      where: { id: replyId },
      data: {
        claudeCategory: analysis.category,
        claudeSentiment: analysis.sentiment,
        claudeSummary: analysis.summary,
        claudeRaw: analysis,
      },
    })
    res.json({ ok: true, data: analysis })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/analyze/vary — Claude Job 3
router.post('/vary', async (req, res) => {
  const { message } = req.body as { message: string }
  if (!message) {
    res.status(400).json({ ok: false, error: 'message is required' })
    return
  }
  try {
    const varied = await varyMessage(message)
    res.json({ ok: true, data: { varied } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

export default router
