import { Router } from 'express'
import { db } from '../lib/db'
import { phoneCheckQueue, redis } from '../lib/queue'

const WA_CHECKING_KEY = (phone: string) => `wa:checking:${phone}`
const WA_CHECKING_TTL = 600 // 10 minutes — safety expiry if worker crashes

const router: import('express').Router = Router()

// GET /api/contacts
router.get('/', async (req, res) => {
  const { departmentId, areaId, contactType, phoneValid, waChecked, page = '1', limit = '50' } =
    req.query as Record<string, string>

  try {
    const where = {
      ...(departmentId && { departmentId }),
      ...(areaId       && { areaId }),
      ...(contactType  && { contactType }),
      ...(phoneValid !== undefined && phoneValid !== '' && { phoneValid: phoneValid === 'true' }),
      ...(waChecked  !== undefined && waChecked  !== '' && { waChecked:  waChecked  === 'true' }),
    }

    const [contacts, total] = await Promise.all([
      db.contact.findMany({
        where,
        include: { area: true, department: true },
        skip:    (Number(page) - 1) * Number(limit),
        take:    Number(limit),
        orderBy: [{ department: { name: 'asc' } }, { area: { name: 'asc' } }, { seqNo: 'asc' }],
      }),
      db.contact.count({ where }),
    ])

    // Bulk-check Redis for pending checking status (one MGET for all contacts)
    const checkingKeys = contacts.map((c) => WA_CHECKING_KEY(c.phoneNorm))
    const checkingVals = checkingKeys.length > 0
      ? await redis.mget(...checkingKeys)
      : []
    const contactsWithChecking = contacts.map((c, i) => ({
      ...c,
      waChecking: checkingVals[i] === '1',
    }))

    res.json({ ok: true, data: { contacts: contactsWithChecking, total, page: Number(page), limit: Number(limit) } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/contacts/validate-wa
// Deduplicates by phoneNorm before enqueuing — one check per unique phone number.
// The worker writes results to ALL contacts sharing that phoneNorm (STIK + KARDUS).
router.post('/validate-wa', async (req, res) => {
  try {
    const { areaId, contactType, recheck = false } =
      req.body as { areaId?: string; contactType?: string; recheck?: boolean }

    const contacts = await db.contact.findMany({
      where: {
        ...(areaId      && { areaId }),
        ...(contactType && { contactType }),
        phoneValid: recheck ? undefined : true,
        waChecked:  recheck ? undefined : false,
      },
      select: { id: true, phoneNorm: true },
    })

    if (contacts.length === 0) {
      res.json({ ok: true, data: { queued: 0 } })
      return
    }

    // Deduplicate by phoneNorm — one job per unique phone number
    const seen = new Set<string>()
    const jobs = contacts
      .filter((c) => {
        if (seen.has(c.phoneNorm)) return false
        seen.add(c.phoneNorm)
        return true
      })
      .map((c) => ({
        name: `check:${c.phoneNorm}`,
        data: { phone: c.phoneNorm, contactId: c.id },
      }))

    await phoneCheckQueue.addBulk(jobs as never)

    // Mark each phone as "pending checking" in Redis so the contacts list
    // can show a "Pending Checking" badge while the job is in the queue.
    const pipeline = redis.pipeline()
    for (const job of jobs) {
      pipeline.setex(WA_CHECKING_KEY(job.data.phone), WA_CHECKING_TTL, '1')
    }
    await pipeline.exec()

    console.log(`[api] validate-wa — ${jobs.length} unique phones queued (${contacts.length} contacts)`)

    res.json({ ok: true, data: { queued: jobs.length } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// GET /api/contacts/validate-wa/status
router.get('/validate-wa/status', async (_req, res) => {
  try {
    const counts = await phoneCheckQueue.getJobCounts('waiting', 'active', 'completed', 'failed')
    res.json({
      ok:   true,
      data: {
        waiting:   counts.waiting   ?? 0,
        active:    counts.active    ?? 0,
        completed: counts.completed ?? 0,
        failed:    counts.failed    ?? 0,
        total:     (counts.waiting ?? 0) + (counts.active ?? 0),
      },
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// GET /api/contacts/:id
router.get('/:id', async (req, res) => {
  try {
    const contact = await db.contact.findUnique({
      where:   { id: req.params.id },
      include: {
        area:       true,
        department: true,
        messages: {
          include:  { reply: true },
          orderBy:  { createdAt: 'desc' },
          take:     10,
        },
      },
    })
    if (!contact) { res.status(404).json({ ok: false, error: 'Contact not found' }); return }
    res.json({ ok: true, data: contact })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

export default router
