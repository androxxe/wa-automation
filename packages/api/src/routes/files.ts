import { Router } from 'express'
import { z } from 'zod'
import { scanDataFolder, parseSheet, parseSheetWithMapping } from '../lib/excel'
import { mapHeaders } from '../lib/llm'
import { normalizePhone } from '../lib/phone'
import { db } from '../lib/db'
import type { ContactType } from '@aice/shared'

const router: import('express').Router = Router()

// GET /api/files/scan — 3-level tree: type → dept → area
router.get('/scan', (_req, res) => {
  try {
    const tree = scanDataFolder()
    res.json({ ok: true, data: tree })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// GET /api/files/areas — imported areas from DB grouped by contactType → department
router.get('/areas', async (_req, res) => {
  try {
    const departments = await db.department.findMany({
      include: {
        areas: { orderBy: { name: 'asc' } },
      },
      orderBy: { name: 'asc' },
    })
    res.json({ ok: true, data: departments })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/files/parse
router.post('/parse', (req, res) => {
  const { filePath } = req.body as { filePath: string }
  if (!filePath) { res.status(400).json({ ok: false, error: 'filePath is required' }); return }
  try {
    res.json({ ok: true, data: parseSheet(filePath) })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/files/import
const ImportBody = z.object({
  filePath:       z.string(),
  departmentName: z.string(),
  areaName:       z.string(),
  contactType:    z.enum(['STIK', 'KARDUS']),
  mapping: z.object({
    phone:          z.string().nullable(),
    store_name:     z.string().nullable(),
    seq_no:         z.string().nullable(),
    freezer_id:     z.string().nullable(),
    exchange_count: z.string().nullable(),
    award_count:    z.string().nullable(),
    total_count:    z.string().nullable(),
  }),
})

router.post('/import', async (req, res) => {
  const parsed = ImportBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.message })
    return
  }

  const { filePath, departmentName, areaName, contactType, mapping } = parsed.data

  try {
    const department = await db.department.upsert({
      where:  { name: departmentName },
      update: {},
      create: { name: departmentName, path: filePath.split('/').slice(0, -1).join('/') },
    })

    const area = await db.area.upsert({
      where: {
        departmentId_name_contactType: {
          departmentId: department.id,
          name:         areaName,
          contactType,
        },
      },
      update: { columnMapping: mapping, filePath },
      create: {
        name:         areaName,
        contactType,
        fileName:     filePath.split('/').pop() ?? areaName,
        filePath,
        columnMapping: mapping,
        departmentId:  department.id,
      },
    })

    const rows = parseSheetWithMapping(filePath, mapping as Record<string, string>)

    let imported = 0, invalid = 0, duplicates = 0

    for (const row of rows) {
      const rawPhone = String(row.phone ?? '').trim()
      if (!rawPhone) { invalid++; continue }

      const { normalized, valid } = normalizePhone(rawPhone)

      const contactData = {
        seqNo:         row.seq_no    ? String(row.seq_no)    : null,
        storeName:     String(row.store_name ?? ''),
        freezerId:     row.freezer_id ? String(row.freezer_id) : null,
        phoneRaw:      rawPhone,
        contactType:   contactType as ContactType,
        exchangeCount: row.exchange_count ? Number(row.exchange_count) : null,
        awardCount:    row.award_count    ? Number(row.award_count)    : null,
        totalCount:    row.total_count    ? Number(row.total_count)    : null,
      }

      try {
        await db.contact.upsert({
          where: { areaId_phoneNorm: { areaId: area.id, phoneNorm: normalized } },
          update: { ...contactData, phoneValid: valid, waChecked: !valid },
          create: {
            ...contactData,
            phoneNorm:    normalized,
            phoneValid:   valid,
            waChecked:    !valid,
            areaId:       area.id,
            departmentId: department.id,
          },
        })
        if (valid) imported++; else invalid++
      } catch (e: unknown) {
        if (e instanceof Error && e.message.includes('Unique constraint')) duplicates++
        else invalid++
      }
    }

    res.json({ ok: true, data: { imported, invalid, duplicates } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

export default router
