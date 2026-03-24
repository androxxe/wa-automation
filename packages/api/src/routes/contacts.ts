import { Router } from 'express'
import { db } from '../lib/db'
import { phoneCheckQueue, redis } from '../lib/queue'

const WA_CHECKING_KEY = (phone: string) => `wa:checking:${phone}`
const WA_CHECKING_TTL = 600 // 10 minutes — safety expiry if worker crashes

const router: import('express').Router = Router()

// GET /api/areas  — returns all areas for filter dropdown
router.get('/areas', async (_req, res) => {
  try {
    const areas = await db.area.findMany({
      select: { id: true, name: true, contactType: true },
      orderBy: { name: 'asc' },
    })
    res.json({ ok: true, data: areas })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

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

// GET /api/contacts/validate-wa/count
// Returns how many contacts are unchecked (phoneValid=true, waChecked=false)
// plus the number of distinct areas that have unchecked contacts.
// Used by the frontend modal to show context before queuing validation jobs.
router.get('/validate-wa/count', async (_req, res) => {
  try {
    const where = { phoneValid: true, waChecked: false as const }
    const [unchecked, areaGroups] = await Promise.all([
      db.contact.count({ where }),
      db.contact.groupBy({ by: ['areaId'], where, _count: true }),
    ])

    // Fetch area details for each group so the modal can render checkboxes
    const areaIds = areaGroups.map((g) => g.areaId)
    const areaDetails = areaIds.length > 0
      ? await db.area.findMany({
          where: { id: { in: areaIds } },
          select: { id: true, name: true, contactType: true },
        })
      : []

    const areaMap = new Map(areaDetails.map((a) => [a.id, a]))
    const areas = areaGroups
      .map((g) => {
        const area = areaMap.get(g.areaId)
        if (!area) return null
        return { areaId: g.areaId, name: area.name, contactType: area.contactType, unchecked: g._count }
      })
      .filter(Boolean)
      .sort((a, b) => a!.name.localeCompare(b!.name))

    res.json({ ok: true, data: { unchecked, areaCount: areaGroups.length, areas } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/contacts/validate-wa
// Deduplicates by phoneNorm before enqueuing — one check per unique phone number.
// The worker writes results to ALL contacts sharing that phoneNorm (STIK + KARDUS).
// Optional params:
//   - `areaIds`      : array of area IDs — only queue contacts from these areas
//   - `areaId`       : single area ID (legacy, use areaIds instead)
//   - `limit`        : global cap — only queue the first N unchecked contacts total
//   - `limitPerArea` : per-area cap — take at most N unchecked contacts from each area
// When `limitPerArea` is provided, it takes priority over `limit`.
router.post('/validate-wa', async (req, res) => {
  try {
    const { areaId, areaIds, contactType, recheck = false, limit, limitPerArea } =
      req.body as { areaId?: string; areaIds?: string[]; contactType?: string; recheck?: boolean; limit?: number; limitPerArea?: number }

    // Support both areaIds (array) and legacy areaId (single string)
    const effectiveAreaFilter = areaIds && areaIds.length > 0
      ? { areaId: { in: areaIds } }
      : areaId
        ? { areaId }
        : {}

    const baseWhere = {
      ...effectiveAreaFilter,
      ...(contactType && { contactType }),
      phoneValid: recheck ? undefined : true,
      waChecked:  recheck ? undefined : false,
    }

    let contacts: { id: string; phoneNorm: string; areaId: string }[]

    if (!recheck && limitPerArea && limitPerArea > 0) {
      // Per-area limiting: fetch all unchecked contacts with areaId, then slice per area
      const allContacts = await db.contact.findMany({
        where: baseWhere,
        select: { id: true, phoneNorm: true, areaId: true },
        orderBy: { id: 'asc' },
      })

      // Group by areaId and take at most `limitPerArea` from each
      const byArea = new Map<string, typeof allContacts>()
      for (const c of allContacts) {
        const group = byArea.get(c.areaId) ?? []
        if (group.length < limitPerArea) {
          group.push(c)
          byArea.set(c.areaId, group)
        }
      }
      contacts = Array.from(byArea.values()).flat()
    } else {
      // Global limit (or no limit)
      contacts = await db.contact.findMany({
        where: baseWhere,
        select: { id: true, phoneNorm: true, areaId: true },
        orderBy: { id: 'asc' },
        ...((!recheck && limit && limit > 0) ? { take: limit } : {}),
      })
    }

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

    const areaLabel = areaIds?.length ? `, ${areaIds.length} areas selected` : areaId ? ', 1 area selected' : ''
    console.log(`[api] validate-wa — ${jobs.length} unique phones queued (${contacts.length} contacts${limitPerArea ? `, limit ${limitPerArea}/area` : ''}${areaLabel})`)

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

// POST /api/contacts/validate-wa/cancel
// Drains the phone-check queue (removes all waiting jobs) and clears
// the wa:checking:* Redis keys so "Pending Checking" badges disappear.
// Active jobs (currently being processed by an agent) finish naturally.
router.post('/validate-wa/cancel', async (_req, res) => {
  try {
    // Get all waiting jobs so we can clear their Redis checking keys
    const waitingJobs = await phoneCheckQueue.getJobs(['waiting', 'delayed', 'prioritized'])
    const phones = waitingJobs
      .map((j) => j.data?.phone)
      .filter(Boolean) as string[]

    // Drain the queue — removes all waiting/delayed jobs
    await phoneCheckQueue.drain()

    // Clear wa:checking:* keys for the cancelled phones
    if (phones.length > 0) {
      const pipeline = redis.pipeline()
      for (const phone of phones) {
        pipeline.del(WA_CHECKING_KEY(phone))
      }
      await pipeline.exec()
    }

    console.log(`[api] validate-wa/cancel — drained ${phones.length} waiting jobs`)

    res.json({ ok: true, data: { cancelled: phones.length } })
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
