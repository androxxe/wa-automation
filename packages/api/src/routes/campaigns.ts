import { Router } from 'express'
import { z } from 'zod'
import { db } from '../lib/db'
import { messageQueue } from '../lib/queue'
import type { MessageJob } from '@aice/shared'

const router = Router()

// GET /api/campaigns
router.get('/', async (_req, res) => {
  try {
    const campaigns = await db.campaign.findMany({
      include: { departments: { include: { department: true } } },
      orderBy: { createdAt: 'desc' },
    })
    res.json({ ok: true, data: campaigns })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/campaigns
const CreateCampaign = z.object({
  name: z.string().min(1),
  template: z.string().min(1),
  bulan: z.string().min(1),
  departmentIds: z.array(z.string()).min(1),
})

router.post('/', async (req, res) => {
  const parsed = CreateCampaign.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.message })
    return
  }
  const { name, template, bulan, departmentIds } = parsed.data
  try {
    const campaign = await db.campaign.create({
      data: {
        name,
        template,
        bulan,
        departments: {
          create: departmentIds.map((id) => ({ departmentId: id })),
        },
      },
    })
    res.status(201).json({ ok: true, data: campaign })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// GET /api/campaigns/:id
router.get('/:id', async (req, res) => {
  try {
    const campaign = await db.campaign.findUnique({
      where: { id: req.params.id },
      include: { departments: { include: { department: true } } },
    })
    if (!campaign) {
      res.status(404).json({ ok: false, error: 'Campaign not found' })
      return
    }
    res.json({ ok: true, data: campaign })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// PATCH /api/campaigns/:id
router.patch('/:id', async (req, res) => {
  try {
    const campaign = await db.campaign.findUnique({ where: { id: req.params.id } })
    if (!campaign) { res.status(404).json({ ok: false, error: 'Not found' }); return }
    if (campaign.status !== 'DRAFT') {
      res.status(400).json({ ok: false, error: 'Only DRAFT campaigns can be edited' })
      return
    }
    const updated = await db.campaign.update({
      where: { id: req.params.id },
      data: req.body,
    })
    res.json({ ok: true, data: updated })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// DELETE /api/campaigns/:id
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

// POST /api/campaigns/:id/enqueue — enqueue all contacts into bullmq
router.post('/:id/enqueue', async (req, res) => {
  try {
    const campaign = await db.campaign.findUnique({
      where: { id: req.params.id },
      include: { departments: true },
    })
    if (!campaign) { res.status(404).json({ ok: false, error: 'Not found' }); return }
    if (!['DRAFT', 'PAUSED'].includes(campaign.status)) {
      res.status(400).json({ ok: false, error: 'Campaign cannot be started in its current state' })
      return
    }

    const departmentIds = campaign.departments.map((d) => d.departmentId)
    const contacts = await db.contact.findMany({
      where: { departmentId: { in: departmentIds }, phoneValid: true },
    })

    // Create Message records and enqueue jobs
    const jobs: Array<{ name: string; data: MessageJob }> = []
    for (const contact of contacts) {
      // Render template
      const body = campaign.template
        .replace('{{no}}', contact.seqNo ?? '')
        .replace('{{nama_toko}}', contact.storeName)
        .replace('{{bulan}}', campaign.bulan)

      const message = await db.message.create({
        data: {
          campaignId: campaign.id,
          contactId: contact.id,
          phone: contact.phoneNorm,
          body,
          status: 'QUEUED',
        },
      })

      jobs.push({
        name: `msg:${message.id}`,
        data: {
          messageId: message.id,
          campaignId: campaign.id,
          contactId: contact.id,
          phone: contact.phoneNorm,
          body,
        },
      })
    }

    await messageQueue.addBulk(jobs)
    await db.campaign.update({
      where: { id: campaign.id },
      data: { status: 'RUNNING', totalCount: contacts.length, startedAt: new Date() },
    })

    res.json({ ok: true, data: { enqueued: jobs.length } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/campaigns/:id/pause
router.post('/:id/pause', async (req, res) => {
  try {
    await messageQueue.pause()
    await db.campaign.update({ where: { id: req.params.id }, data: { status: 'PAUSED' } })
    res.json({ ok: true, data: null })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/campaigns/:id/resume
router.post('/:id/resume', async (req, res) => {
  try {
    await messageQueue.resume()
    await db.campaign.update({ where: { id: req.params.id }, data: { status: 'RUNNING' } })
    res.json({ ok: true, data: null })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/campaigns/:id/cancel
router.post('/:id/cancel', async (req, res) => {
  try {
    // Drain pending jobs for this campaign
    const waiting = await messageQueue.getWaiting()
    for (const job of waiting) {
      if (job.data.campaignId === req.params.id) await job.remove()
    }
    await db.campaign.update({ where: { id: req.params.id }, data: { status: 'CANCELLED' } })
    res.json({ ok: true, data: null })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// GET /api/campaigns/:id/events — SSE live progress
router.get('/:id/events', (req, res) => {
  const campaignId = req.params.id
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // TODO: subscribe to Redis pub/sub channel `campaign:${campaignId}:events`
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000)
  req.on('close', () => clearInterval(keepAlive))
})

// GET /api/campaigns/:id/messages
router.get('/:id/messages', async (req, res) => {
  const { page = '1', limit = '50', status } = req.query as Record<string, string>
  try {
    const where = {
      campaignId: req.params.id,
      ...(status && { status }),
    }
    const [messages, total] = await Promise.all([
      db.message.findMany({
        where,
        include: { contact: true, reply: true },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
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
