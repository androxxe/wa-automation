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
// Returns all areas with per-area breakdown: unchecked, validated, and total counts.
// Areas that are already fully validated (unchecked=0) are included so the modal
// can show them as re-checkable (unchecked by default, muted style).
router.get('/validate-wa/count', async (_req, res) => {
  try {
    // Fetch all areas and counts in parallel
    const [allAreas, uncheckedGroups, validatedGroups, registeredGroups, invalidGroups, totalGroups, globalUnchecked] = await Promise.all([
      db.area.findMany({
        select: { id: true, name: true, contactType: true },
        orderBy: { name: 'asc' },
      }),
      db.contact.groupBy({
        by: ['areaId'],
        where: { phoneValid: true, waChecked: false },
        _count: true,
      }),
      db.contact.groupBy({
        by: ['areaId'],
        where: { waChecked: true },
        _count: true,
      }),
      db.contact.groupBy({
        by: ['areaId'],
        where: { waChecked: true, phoneValid: true },
        _count: true,
      }),
      db.contact.groupBy({
        by: ['areaId'],
        where: { phoneValid: false },
        _count: true,
      }),
      db.contact.groupBy({
        by: ['areaId'],
        _count: true,
      }),
      db.contact.count({ where: { phoneValid: true, waChecked: false } }),
    ])

    const uncheckedMap   = new Map(uncheckedGroups.map((g) => [g.areaId, g._count]))
    const validatedMap   = new Map(validatedGroups.map((g) => [g.areaId, g._count]))
    const registeredMap  = new Map(registeredGroups.map((g) => [g.areaId, g._count]))
    const invalidMap     = new Map(invalidGroups.map((g) => [g.areaId, g._count]))
    const totalMap       = new Map(totalGroups.map((g) => [g.areaId, g._count]))

    const areas = allAreas
      .map((a) => {
        const total     = totalMap.get(a.id) ?? 0
        if (total === 0) return null // skip areas with no contacts
        return {
          areaId:      a.id,
          name:        a.name,
          contactType: a.contactType,
          unchecked:   uncheckedMap.get(a.id) ?? 0,
          validated:   validatedMap.get(a.id) ?? 0,
          registered:  registeredMap.get(a.id) ?? 0,
          invalid:     invalidMap.get(a.id) ?? 0,
          total,
        }
      })
      .filter(Boolean)
      .sort((a, b) => a!.name.localeCompare(b!.name))

    const areaCount = areas.filter((a) => a!.unchecked > 0).length

    res.json({ ok: true, data: { unchecked: globalUnchecked, areaCount, areas } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/contacts/validate-wa
// Deduplicates by phoneNorm before enqueuing — one check per unique phone number.
// The worker writes results to ALL contacts sharing that phoneNorm (STIK + KARDUS).
// Optional params:
//   - `areaIds`         : array of area IDs with unchecked contacts to validate
//   - `recheckAreaIds`  : array of area IDs that are already validated — re-check all phones
//   - `areaId`          : single area ID (legacy, use areaIds instead)
//   - `limit`           : global cap — only queue the first N unchecked contacts total
//   - `limitPerArea`    : per-area cap — take at most N contacts from each area
// When `limitPerArea` is provided, it takes priority over `limit`.
router.post('/validate-wa', async (req, res) => {
  try {
    const { areaId, areaIds, recheckAreaIds, contactType, recheck = false, limit, limitPerArea } =
      req.body as { areaId?: string; areaIds?: string[]; recheckAreaIds?: string[]; contactType?: string; recheck?: boolean; limit?: number; limitPerArea?: number }

    // Support both areaIds (array) and legacy areaId (single string)
    const effectiveAreaIds = areaIds && areaIds.length > 0
      ? areaIds
      : areaId
        ? [areaId]
        : []

    const hasNormalAreas  = effectiveAreaIds.length > 0
    const hasRecheckAreas = recheckAreaIds && recheckAreaIds.length > 0

    // --- Fetch normal unchecked contacts ---
    let normalContacts: { id: string; phoneNorm: string; areaId: string }[] = []
    if (hasNormalAreas || (!hasRecheckAreas && !recheck)) {
      const normalWhere = {
        ...(hasNormalAreas ? { areaId: { in: effectiveAreaIds } } : {}),
        ...(contactType && { contactType }),
        phoneValid: recheck ? undefined : true,
        waChecked:  recheck ? undefined : false,
      }

      if (!recheck && limitPerArea && limitPerArea > 0) {
        const allContacts = await db.contact.findMany({
          where: normalWhere,
          select: { id: true, phoneNorm: true, areaId: true },
          orderBy: { id: 'asc' },
        })
        const byArea = new Map<string, typeof allContacts>()
        for (const c of allContacts) {
          const group = byArea.get(c.areaId) ?? []
          if (group.length < limitPerArea) {
            group.push(c)
            byArea.set(c.areaId, group)
          }
        }
        normalContacts = Array.from(byArea.values()).flat()
      } else {
        normalContacts = await db.contact.findMany({
          where: normalWhere,
          select: { id: true, phoneNorm: true, areaId: true },
          orderBy: { id: 'asc' },
          ...((!recheck && limit && limit > 0) ? { take: limit } : {}),
        })
      }
    }

    // --- Fetch re-check contacts (already validated areas) ---
    let recheckContacts: { id: string; phoneNorm: string; areaId: string }[] = []
    if (hasRecheckAreas) {
      const recheckWhere = {
        areaId: { in: recheckAreaIds },
        ...(contactType && { contactType }),
      }

      if (limitPerArea && limitPerArea > 0) {
        const allRecheck = await db.contact.findMany({
          where: recheckWhere,
          select: { id: true, phoneNorm: true, areaId: true },
          orderBy: { id: 'asc' },
        })
        const byArea = new Map<string, typeof allRecheck>()
        for (const c of allRecheck) {
          const group = byArea.get(c.areaId) ?? []
          if (group.length < limitPerArea) {
            group.push(c)
            byArea.set(c.areaId, group)
          }
        }
        recheckContacts = Array.from(byArea.values()).flat()
      } else {
        recheckContacts = await db.contact.findMany({
          where: recheckWhere,
          select: { id: true, phoneNorm: true, areaId: true },
          orderBy: { id: 'asc' },
        })
      }
    }

    // Combine both sets
    const contacts = [...normalContacts, ...recheckContacts]

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

    const normalLabel  = hasNormalAreas ? `${effectiveAreaIds.length} areas` : 'all areas'
    const recheckLabel = hasRecheckAreas ? `, ${recheckAreaIds!.length} recheck areas` : ''
    console.log(`[api] validate-wa — ${jobs.length} unique phones queued (${contacts.length} contacts, ${normalLabel}${recheckLabel}${limitPerArea ? `, limit ${limitPerArea}/area` : ''})`)

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
