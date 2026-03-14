import { Router } from 'express'
import { db } from '../lib/db'
import { phoneCheckQueue } from '../lib/queue'

const router: import('express').Router = Router()

// GET /api/contacts
router.get('/', async (req, res) => {
  const { departmentId, areaId, phoneValid, waChecked, page = '1', limit = '50' } = req.query as Record<string, string>

  try {
    const where = {
      ...(departmentId && { departmentId }),
      ...(areaId && { areaId }),
      ...(phoneValid !== undefined && phoneValid !== '' && { phoneValid: phoneValid === 'true' }),
      ...(waChecked !== undefined && waChecked !== '' && { waChecked: waChecked === 'true' }),
    }

    const [contacts, total] = await Promise.all([
      db.contact.findMany({
        where,
        include: { area: true, department: true },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
        orderBy: [{ department: { name: 'asc' } }, { area: { name: 'asc' } }, { seqNo: 'asc' }],
      }),
      db.contact.count({ where }),
    ])

    res.json({ ok: true, data: { contacts, total, page: Number(page), limit: Number(limit) } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/contacts/validate-wa
// Queues background phone-check jobs.
// By default only queues unchecked contacts (waChecked=false, phoneValid=true).
// Pass { recheck: true } to force-revalidate already-checked contacts too.
router.post('/validate-wa', async (req, res) => {
  try {
    const { areaId, recheck = false } = req.body as { areaId?: string; recheck?: boolean }

    const contacts = await db.contact.findMany({
      where: {
        ...(areaId && { areaId }),
        // Only re-check format-valid phones — format-invalid are already known bad.
        // Unless recheck=true, skip contacts already checked.
        phoneValid: recheck ? undefined : true,
        waChecked: recheck ? undefined : false,
      },
      select: { id: true, phoneNorm: true },
    })

    if (contacts.length === 0) {
      res.json({ ok: true, data: { queued: 0 } })
      return
    }

    const jobs = contacts.map((c) => ({
      name: `check:${c.phoneNorm}`,
      data: { phone: c.phoneNorm, contactId: c.id },
    }))

    await phoneCheckQueue.addBulk(jobs as never)

    res.json({ ok: true, data: { queued: jobs.length } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// GET /api/contacts/validate-wa/status — live queue job counts
router.get('/validate-wa/status', async (_req, res) => {
  try {
    const counts = await phoneCheckQueue.getJobCounts('waiting', 'active', 'completed', 'failed')
    res.json({
      ok: true,
      data: {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        total: (counts.waiting ?? 0) + (counts.active ?? 0),
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
      where: { id: req.params.id },
      include: { area: true, department: true, messages: { include: { reply: true }, orderBy: { createdAt: 'desc' }, take: 10 } },
    })
    if (!contact) {
      res.status(404).json({ ok: false, error: 'Contact not found' })
      return
    }
    res.json({ ok: true, data: contact })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

export default router
