import { Router } from 'express'
import { db } from '../lib/db'

const router: import('express').Router = Router()

// GET /api/contacts
router.get('/', async (req, res) => {
  const { departmentId, areaId, phoneValid, page = '1', limit = '50' } = req.query as Record<string, string>

  try {
    const where = {
      ...(departmentId && { departmentId }),
      ...(areaId && { areaId }),
      ...(phoneValid !== undefined && { phoneValid: phoneValid === 'true' }),
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
