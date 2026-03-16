import { Router } from 'express'
import { z } from 'zod'
import { db } from '../lib/db'
import { messageQueue } from '../lib/queue'
import type { MessageJob } from '@aice/shared'

const router: import('express').Router = Router()

// ─── GET /api/campaigns ───────────────────────────────────────────────────────

router.get('/', async (_req, res) => {
  try {
    const campaigns = await db.campaign.findMany({
      include: { areas: { include: { area: { include: { department: true } } } } },
      orderBy: { createdAt: 'desc' },
    })

    // Compute actual reply count from Reply records (one query for all campaigns)
    // to avoid trusting the potentially-stale denormalized replyCount counter.
    const campaignIds = campaigns.map((c) => c.id)
    const replyCounts = await db.message.groupBy({
      by:    ['campaignId'],
      where: { campaignId: { in: campaignIds }, reply: { isNot: null } },
      _count: { id: true },
    })
    const replyCountMap = new Map(replyCounts.map((r) => [r.campaignId, r._count.id]))

    const data = campaigns.map((c) => ({
      ...c,
      replyCount: replyCountMap.get(c.id) ?? 0,
    }))

    res.json({ ok: true, data })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── POST /api/campaigns ──────────────────────────────────────────────────────

const CreateCampaign = z.object({
  name:                    z.string().min(1),
  template:                z.string().min(1),
  bulan:                   z.string().min(1),
  campaignType:            z.enum(['STIK', 'KARDUS']),
  areaIds:                 z.array(z.string()).min(1),
  targetRepliesPerArea:    z.number().int().min(1).optional(),
  expectedReplyRate:       z.number().min(0.01).max(1).optional(),
  stopOnTargetReached:     z.boolean().optional(),
})

router.post('/', async (req, res) => {
  const parsed = CreateCampaign.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.message })
    return
  }
  const { name, template, bulan, campaignType, areaIds,
          targetRepliesPerArea, expectedReplyRate, stopOnTargetReached } = parsed.data
  try {
    const campaign = await db.campaign.create({
      data: {
        name,
        template,
        bulan,
        campaignType,
        ...(targetRepliesPerArea !== undefined && { targetRepliesPerArea }),
        ...(expectedReplyRate    !== undefined && { expectedReplyRate }),
        ...(stopOnTargetReached  !== undefined && { stopOnTargetReached }),
        areas: { create: areaIds.map((id) => ({ areaId: id })) },
      },
    })
    res.status(201).json({ ok: true, data: campaign })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── GET /api/campaigns/:id ───────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const campaign = await db.campaign.findUnique({
      where:   { id: req.params.id },
      include: {
        areas: {
          include: { area: { include: { department: true } } },
        },
      },
    })
    if (!campaign) { res.status(404).json({ ok: false, error: 'Campaign not found' }); return }

    res.json({ ok: true, data: campaign })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── PATCH /api/campaigns/:id ─────────────────────────────────────────────────

router.patch('/:id', async (req, res) => {
  try {
    const campaign = await db.campaign.findUnique({ where: { id: req.params.id } })
    if (!campaign) { res.status(404).json({ ok: false, error: 'Not found' }); return }
    if (campaign.status !== 'DRAFT') {
      res.status(400).json({ ok: false, error: 'Only DRAFT campaigns can be edited' })
      return
    }
    const updated = await db.campaign.update({ where: { id: req.params.id }, data: req.body })
    res.json({ ok: true, data: updated })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── DELETE /api/campaigns/:id ────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  try {
    const campaign = await db.campaign.findUnique({ where: { id: req.params.id } })
    if (!campaign) { res.status(404).json({ ok: false, error: 'Not found' }); return }
    if (campaign.status !== 'DRAFT') {
      res.status(400).json({ ok: false, error: 'Only DRAFT campaigns can be deleted' })
      return
    }
    await db.campaign.delete({ where: { id: req.params.id } })
    res.json({ ok: true, data: null })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── POST /api/campaigns/:id/enqueue ─────────────────────────────────────────
// ?preview=true → return plan without writing anything
// Body: { contactIds?: string[] } — if provided, only enqueue those contacts

router.post('/:id/enqueue', async (req, res) => {
  const preview    = req.query.preview === 'true'
  const { contactIds } = req.body as { contactIds?: string[] }
  const hasCustomSelection = Array.isArray(contactIds) && contactIds.length > 0

  try {
    const campaign = await db.campaign.findUnique({
      where:   { id: req.params.id },
      include: { areas: { include: { area: true } } },
    })
    if (!campaign) { res.status(404).json({ ok: false, error: 'Not found' }); return }
    if (!preview && !['DRAFT', 'PAUSED'].includes(campaign.status)) {
      res.status(400).json({ ok: false, error: 'Campaign cannot be started in its current state' })
      return
    }

    // Resolve effective targeting config
    const appConfig = await db.appConfig.findUnique({ where: { id: 'singleton' } })
    const target    = campaign.targetRepliesPerArea ?? appConfig?.defaultTargetRepliesPerArea ?? 20
    const rate      = campaign.expectedReplyRate    ?? appConfig?.defaultExpectedReplyRate    ?? 0.5
    const sendLimit = Math.ceil(target / rate)

    const previewRows: Array<{
      areaId:        string
      areaName:      string
      totalInArea:   number
      wrongType:     number
      notValidated:  number
      invalidPhone:  number
      available:     number
      willSend:      number
      target:        number
      warning?:      string
    }> = []

    const jobs: Array<{ name: string; data: MessageJob }> = []

    for (const ca of campaign.areas) {
      const area = ca.area

      // Breakdown counts so the user understands why contacts are excluded
      const [totalInArea, wrongType, notValidated, invalidPhone, available] = await Promise.all([
        db.contact.count({ where: { areaId: area.id } }),
        db.contact.count({ where: { areaId: area.id, contactType: { not: campaign.campaignType } } }),
        db.contact.count({ where: { areaId: area.id, contactType: campaign.campaignType, phoneValid: true, waChecked: false } }),
        db.contact.count({ where: { areaId: area.id, contactType: campaign.campaignType, phoneValid: false } }),
        db.contact.count({
          where: {
            areaId:      area.id,
            contactType: campaign.campaignType,
            phoneValid:  true,
            waChecked:   true,
            messages:    { none: { campaignId: campaign.id } },
          },
        }),
      ])

      // Fetch actual contacts for enqueuing (skip on preview)
      // If contactIds provided: filter to only selected contacts within this area
      const contacts = preview ? [] : await db.contact.findMany({
        where: {
          areaId:      area.id,
          contactType: campaign.campaignType,
          phoneValid:  true,
          waChecked:   true,
          messages:    { none: { campaignId: campaign.id } },
          ...(hasCustomSelection && { id: { in: contactIds } }),
        },
        orderBy: { createdAt: 'asc' },
        // Only apply sendLimit when auto-selecting — custom selection uses exact list
        take: hasCustomSelection ? undefined : sendLimit,
      })

      const willSend = preview ? Math.min(available, sendLimit) : contacts.length

      const warnings: string[] = []
      if (notValidated > 0) warnings.push(`${notValidated} not WA-validated yet`)
      if (wrongType > 0)    warnings.push(`${wrongType} wrong type (not ${campaign.campaignType})`)
      if (available < sendLimit) warnings.push(`only ${available} ready (need ${sendLimit})`)

      const row = {
        areaId:       area.id,
        areaName:     area.name,
        totalInArea,
        wrongType,
        notValidated,
        invalidPhone,
        available,
        willSend,
        target,
        ...(warnings.length > 0 && { warning: warnings.join('; ') }),
      }
      previewRows.push(row)

      if (preview) continue

      for (const contact of contacts) {
        // Format campaign type for display: STIK → "Stik", KARDUS → "Kardus"
        const tipe = campaign.campaignType.charAt(0).toUpperCase() +
                     campaign.campaignType.slice(1).toLowerCase()

        const body = campaign.template
          .replace(/\{\{no\}\}/g,          contact.seqNo   ?? '')
          .replace(/\{\{nama_toko\}\}/g,   contact.storeName)
          .replace(/\{\{bulan\}\}/g,       campaign.bulan)
          .replace(/\{\{area\}\}/g,        area.name)
          .replace(/\{\{department\}\}/g,  contact.departmentId)
          .replace(/\{\{tipe\}\}/g,        tipe)

        const message = await db.message.create({
          data: { campaignId: campaign.id, contactId: contact.id, phone: contact.phoneNorm, body, status: 'QUEUED' },
        })

        jobs.push({
          name: `msg:${message.id}`,
          data: { messageId: message.id, campaignId: campaign.id, contactId: contact.id, phone: contact.phoneNorm, body },
        })
      }

      if (!preview) {
        await db.campaignArea.update({
          where: { campaignId_areaId: { campaignId: campaign.id, areaId: area.id } },
          data:  { sendLimit },
        })
      }
    }

    if (preview) {
      res.json({ ok: true, data: previewRows })
      return
    }

    await messageQueue.addBulk(jobs as never)
    const totalEnqueued = jobs.length
    await db.campaign.update({
      where: { id: campaign.id },
      data:  { status: 'RUNNING', totalCount: totalEnqueued, startedAt: new Date() },
    })

    res.json({ ok: true, data: { enqueued: totalEnqueued, preview: previewRows } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── POST /api/campaigns/:id/pause ───────────────────────────────────────────

router.post('/:id/pause', async (req, res) => {
  try {
    await messageQueue.pause()
    await db.campaign.update({ where: { id: req.params.id }, data: { status: 'PAUSED' } })
    res.json({ ok: true, data: null })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── POST /api/campaigns/:id/resume ──────────────────────────────────────────

router.post('/:id/resume', async (req, res) => {
  try {
    await messageQueue.resume()
    await db.campaign.update({ where: { id: req.params.id }, data: { status: 'RUNNING' } })
    res.json({ ok: true, data: null })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── POST /api/campaigns/:id/cancel ──────────────────────────────────────────

router.post('/:id/cancel', async (req, res) => {
  try {
    const waiting = await messageQueue.getWaiting()
    for (const job of waiting) {
      if (job.data.campaignId === req.params.id) await job.remove()
    }
    await db.message.updateMany({
      where: { campaignId: req.params.id, status: { in: ['PENDING', 'QUEUED'] } },
      data:  { status: 'CANCELLED' },
    })
    await db.campaign.update({ where: { id: req.params.id }, data: { status: 'CANCELLED' } })
    res.json({ ok: true, data: null })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── POST /api/campaigns/:id/topup ───────────────────────────────────────────
// Enqueue the next batch of fresh contacts for areas that sent all their initial
// batch but haven't reached the reply target yet.
// Body: { areaId? } — omit to top-up ALL eligible areas in the campaign.

router.post('/:id/topup', async (req, res) => {
  const { areaId: specificAreaId } = req.body as { areaId?: string }

  try {
    const campaign = await db.campaign.findUnique({
      where:   { id: req.params.id },
      include: { areas: { include: { area: true } } },
    })
    if (!campaign) { res.status(404).json({ ok: false, error: 'Campaign not found' }); return }
    if (!['RUNNING', 'PAUSED'].includes(campaign.status)) {
      res.status(400).json({ ok: false, error: 'Campaign must be RUNNING or PAUSED to top up' })
      return
    }

    const appConfig = await db.appConfig.findUnique({ where: { id: 'singleton' } })
    const target    = campaign.targetRepliesPerArea ?? appConfig?.defaultTargetRepliesPerArea ?? 20
    const rate      = campaign.expectedReplyRate    ?? appConfig?.defaultExpectedReplyRate    ?? 0.5
    const batchSize = Math.ceil(target / rate)

    const areaEntries = specificAreaId
      ? campaign.areas.filter((ca) => ca.areaId === specificAreaId)
      : campaign.areas

    const results: Array<{ areaId: string; areaName: string; enqueued: number; skipped: string | null }> = []
    const jobs: Array<{ name: string; data: MessageJob }> = []

    for (const ca of areaEntries) {
      // Skip areas that already reached their target
      if (ca.targetReached) {
        results.push({ areaId: ca.areaId, areaName: ca.area.name, enqueued: 0, skipped: 'Target already reached' })
        continue
      }
      // Skip areas that still have pending/queued messages
      const pending = await db.message.count({
        where: { campaignId: campaign.id, contact: { areaId: ca.areaId }, status: { in: ['PENDING', 'QUEUED'] } },
      })
      if (pending > 0) {
        results.push({ areaId: ca.areaId, areaName: ca.area.name, enqueued: 0, skipped: `${pending} messages still pending` })
        continue
      }

      // Find fresh contacts not yet messaged in this campaign
      const contacts = await db.contact.findMany({
        where: {
          areaId:      ca.areaId,
          contactType: campaign.campaignType,
          phoneValid:  true,
          waChecked:   true,
          messages:    { none: { campaignId: campaign.id } },
        },
        orderBy: { createdAt: 'asc' },
        take:    batchSize,
      })

      if (contacts.length === 0) {
        results.push({ areaId: ca.areaId, areaName: ca.area.name, enqueued: 0, skipped: 'No fresh contacts remaining' })
        continue
      }

      for (const contact of contacts) {
        const tipe = campaign.campaignType.charAt(0).toUpperCase() +
                     campaign.campaignType.slice(1).toLowerCase()

        const body = campaign.template
          .replace(/\{\{no\}\}/g,         contact.seqNo ?? '')
          .replace(/\{\{nama_toko\}\}/g,  contact.storeName)
          .replace(/\{\{bulan\}\}/g,      campaign.bulan)
          .replace(/\{\{area\}\}/g,       ca.area.name)
          .replace(/\{\{department\}\}/g, contact.departmentId)
          .replace(/\{\{tipe\}\}/g,       tipe)

        const message = await db.message.create({
          data: { campaignId: campaign.id, contactId: contact.id, phone: contact.phoneNorm, body, status: 'QUEUED' },
        })
        jobs.push({
          name: `msg:${message.id}`,
          data: { messageId: message.id, campaignId: campaign.id, contactId: contact.id, phone: contact.phoneNorm, body },
        })
      }

      // Update sendLimit to reflect total contacts now queued for this area
      await db.campaignArea.update({
        where: { campaignId_areaId: { campaignId: campaign.id, areaId: ca.areaId } },
        data:  { sendLimit: { increment: contacts.length } },
      })

      results.push({ areaId: ca.areaId, areaName: ca.area.name, enqueued: contacts.length, skipped: null })
    }

    if (jobs.length > 0) {
      await messageQueue.addBulk(jobs as never)
      await db.campaign.update({
        where: { id: campaign.id },
        data:  { totalCount: { increment: jobs.length } },
      })
    }

    res.json({ ok: true, data: { totalEnqueued: jobs.length, areas: results } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── GET /api/campaigns/:id/contacts ─────────────────────────────────────────
// Returns up to 100 eligible contacts per area for the contact picker.
// Each contact includes alreadyReplied: true if they already have a Reply in any
// campaign with the same bulan + campaignType — to prevent double-sending.

router.get('/:id/contacts', async (req, res) => {
  try {
    const campaign = await db.campaign.findUnique({
      where:   { id: req.params.id },
      include: { areas: { include: { area: true } } },
    })
    if (!campaign) { res.status(404).json({ ok: false, error: 'Campaign not found' }); return }

    // Find all contacts who already replied in any campaign with same bulan + campaignType
    const repliedContacts = await db.contact.findMany({
      where: {
        messages: {
          some: {
            reply:    { isNot: null },
            campaign: { bulan: campaign.bulan, campaignType: campaign.campaignType },
          },
        },
      },
      select: { id: true },
    })
    const repliedSet = new Set(repliedContacts.map((c) => c.id))

    const grouped = await Promise.all(
      campaign.areas.map(async (ca) => {
        const contacts = await db.contact.findMany({
          where: {
            areaId:      ca.areaId,
            contactType: campaign.campaignType,
            phoneValid:  true,
            waChecked:   true,
          },
          select: {
            id:        true,
            storeName: true,
            phoneNorm: true,
            seqNo:     true,
          },
          orderBy: [{ seqNo: 'asc' }, { storeName: 'asc' }],
          take:    100,
        })

        return {
          areaId:   ca.areaId,
          areaName: ca.area.name,
          contacts: contacts.map((c) => ({
            ...c,
            alreadyReplied: repliedSet.has(c.id),
          })),
        }
      }),
    )

    res.json({ ok: true, data: grouped })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── POST /api/campaigns/:id/retry-failed ────────────────────────────────────
// Re-enqueue FAILED messages. Body: { messageIds?: string[] }
// Skips contacts marked phoneValid=false (unregistered numbers) unless explicitly listed.

router.post('/:id/retry-failed', async (req, res) => {
  const { messageIds } = req.body as { messageIds?: string[] }
  const hasFilter = Array.isArray(messageIds) && messageIds.length > 0

  try {
    const campaign = await db.campaign.findUnique({ where: { id: req.params.id } })
    if (!campaign) { res.status(404).json({ ok: false, error: 'Not found' }); return }
    if (campaign.status === 'CANCELLED') {
      res.status(400).json({ ok: false, error: 'Cannot retry messages in a cancelled campaign' })
      return
    }

    const failedMessages = await db.message.findMany({
      where: {
        campaignId: req.params.id,
        status:     'FAILED',
        ...(hasFilter && { id: { in: messageIds } }),
      },
      include: { contact: true },
    })

    if (failedMessages.length === 0) {
      res.json({ ok: true, data: { retried: 0, skipped: 0 } })
      return
    }

    // Skip contacts whose phone was flagged as unregistered
    const retryable = failedMessages.filter((m) => m.contact.phoneValid !== false)
    const skipped   = failedMessages.length - retryable.length

    if (retryable.length === 0) {
      res.json({ ok: true, data: { retried: 0, skipped } })
      return
    }

    const retryIds = retryable.map((m) => m.id)

    await db.message.updateMany({
      where: { id: { in: retryIds } },
      data:  { status: 'QUEUED', failedAt: null, failReason: null },
    })

    await db.campaign.update({
      where: { id: req.params.id },
      data:  { failedCount: { decrement: retryable.length } },
    })

    const jobs = retryable.map((m) => ({
      name: `msg:${m.id}`,
      data: {
        messageId:  m.id,
        campaignId: req.params.id,
        contactId:  m.contactId,
        phone:      m.phone,
        body:       m.body,
      } satisfies import('@aice/shared').MessageJob,
    }))
    await messageQueue.addBulk(jobs as never)

    res.json({ ok: true, data: { retried: retryable.length, skipped } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── DELETE /api/campaigns/:id/messages/:messageId ───────────────────────────
// Cancel a single QUEUED or FAILED message (sets status → CANCELLED).
// Pulls the job from BullMQ if still queued.

router.delete('/:id/messages/:messageId', async (req, res) => {
  try {
    const message = await db.message.findUnique({
      where: { id: req.params.messageId },
    })
    if (!message || message.campaignId !== req.params.id) {
      res.status(404).json({ ok: false, error: 'Message not found' }); return
    }
    if (!['QUEUED', 'FAILED'].includes(message.status)) {
      res.status(400).json({ ok: false, error: `Cannot cancel a message with status ${message.status}` })
      return
    }

    // Remove from BullMQ if it is still queued (waiting / delayed)
    if (message.status === 'QUEUED') {
      const jobs = await messageQueue.getJobs(['waiting', 'delayed', 'prioritized'])
      for (const job of jobs) {
        if (job.data.messageId === req.params.messageId) {
          await job.remove().catch(() => {})
          break
        }
      }
    }

    await db.message.update({
      where: { id: req.params.messageId },
      data:  { status: 'CANCELLED' },
    })

    // Adjust failedCount if transitioning from FAILED → CANCELLED
    if (message.status === 'FAILED') {
      await db.campaign.update({
        where: { id: req.params.id },
        data:  { failedCount: { decrement: 1 } },
      })
    }

    res.json({ ok: true, data: null })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ─── GET /api/campaigns/:id/events ───────────────────────────────────────────

router.get('/:id/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000)
  req.on('close', () => clearInterval(keepAlive))
})

// ─── GET /api/campaigns/:id/messages ─────────────────────────────────────────

router.get('/:id/messages', async (req, res) => {
  const { page = '1', limit = '50', status } = req.query as Record<string, string>
  try {
    const where = { campaignId: req.params.id, ...(status && { status }) }
    const [messages, total] = await Promise.all([
      db.message.findMany({
        where,
        include: { contact: { include: { area: true } }, reply: true, agent: true },
        skip:    (Number(page) - 1) * Number(limit),
        take:    Number(limit),
        orderBy: { createdAt: 'asc' },
      }),
      db.message.count({ where }),
    ])
    res.json({ ok: true, data: { messages, total, page: Number(page), limit: Number(limit) } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

export default router
