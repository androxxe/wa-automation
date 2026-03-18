import { Router } from 'express'
import { db } from '../lib/db'
import { presignedUrl, objectExists } from '../lib/minio'

const router: import('express').Router = Router()

// ─── GET /api/replies ─────────────────────────────────────────────────────────
// Query params:
//   campaignId  — filter by campaign
//   category    — 'confirmed'|'denied'|'question'|'unclear'|'other'
//   jawaban     — '1' (yes) | '0' (no) | 'null' (unclear)
//   page        — default 1
//   limit       — default 50, max 200

router.get('/', async (req, res) => {
  try {
    const {
      campaignId,
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

    if (campaignId) {
      where.message = { campaignId }
    }

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

// ─── GET /api/replies/screenshot — redirect to MinIO presigned URL ────────────
// Query param: ?p=screenshots/filename.jpg (MinIO object key)

router.get('/screenshot', async (req, res) => {
  const key = req.query.p as string | undefined
  if (!key) {
    res.status(404).json({ ok: false, error: 'Not found' })
    return
  }

  // Prevent path traversal
  if (key.includes('..') || key.startsWith('/')) {
    res.status(403).json({ ok: false, error: 'Forbidden' })
    return
  }

  try {
    const exists = await objectExists(key)
    if (!exists) {
      res.status(404).json({ ok: false, error: 'Screenshot not found' })
      return
    }

    const url = await presignedUrl(key, 3600) // 1 hour expiry
    res.redirect(url)
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

export default router
