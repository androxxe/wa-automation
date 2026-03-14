import { Router } from 'express'
import { z } from 'zod'
import { scanDataFolder, parseSheet, parseSheetWithMapping } from '../lib/excel'
import { mapHeaders } from '../lib/claude'
import { normalizePhone } from '../lib/phone'
import { db } from '../lib/db'

const router = Router()

// GET /api/files/scan — scan DATA_FOLDER and return department/area tree
router.get('/scan', (_req, res) => {
  try {
    const tree = scanDataFolder()
    res.json({ ok: true, data: tree })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/files/parse — parse a single xlsx, return headers + sample rows
router.post('/parse', (req, res) => {
  const { filePath } = req.body as { filePath: string }
  if (!filePath) {
    res.status(400).json({ ok: false, error: 'filePath is required' })
    return
  }
  try {
    const result = parseSheet(filePath)
    res.json({ ok: true, data: result })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/analyze/headers — suggest column mapping via Claude
// (also accessible via /api/analyze/headers — see analyze router)

// POST /api/files/import — confirm mapping, normalize phones, save to DB
const ImportBody = z.object({
  filePath: z.string(),
  departmentName: z.string(),
  areaName: z.string(),
  mapping: z.object({
    phone: z.string().nullable(),
    store_name: z.string().nullable(),
    seq_no: z.string().nullable(),
    freezer_id: z.string().nullable(),
    exchange_count: z.string().nullable(),
    award_count: z.string().nullable(),
    total_count: z.string().nullable(),
  }),
})

router.post('/import', async (req, res) => {
  const parsed = ImportBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.message })
    return
  }

  const { filePath, departmentName, areaName, mapping } = parsed.data

  try {
    // Upsert Department
    const department = await db.department.upsert({
      where: { name: departmentName },
      update: {},
      create: { name: departmentName, path: filePath.split('/').slice(0, -1).join('/') },
    })

    // Upsert Area
    const area = await db.area.upsert({
      where: { departmentId_name: { departmentId: department.id, name: areaName } },
      update: { columnMapping: mapping, filePath },
      create: {
        name: areaName,
        fileName: filePath.split('/').pop() ?? areaName,
        filePath,
        columnMapping: mapping,
        departmentId: department.id,
      },
    })

    // Parse rows with mapping
    const rows = parseSheetWithMapping(filePath, mapping as Record<string, string>)

    let imported = 0
    let invalid = 0
    let duplicates = 0

    for (const row of rows) {
      const rawPhone = String(row.phone ?? '').trim()
      if (!rawPhone) { invalid++; continue }

      const { normalized, valid, reason } = normalizePhone(rawPhone)

      if (!valid) {
        // Still store with phoneValid=false so user can see them
        try {
          await db.contact.create({
            data: {
              seqNo: row.seq_no ? String(row.seq_no) : null,
              storeName: String(row.store_name ?? ''),
              freezerId: row.freezer_id ? String(row.freezer_id) : null,
              phoneRaw: rawPhone,
              phoneNorm: normalized,
              phoneValid: false,
              exchangeCount: row.exchange_count ? Number(row.exchange_count) : null,
              awardCount: row.award_count ? Number(row.award_count) : null,
              totalCount: row.total_count ? Number(row.total_count) : null,
              areaId: area.id,
              departmentId: department.id,
            },
          })
          invalid++
        } catch {
          invalid++
        }
        continue
      }

      try {
        await db.contact.upsert({
          where: { areaId_phoneNorm: { areaId: area.id, phoneNorm: normalized } },
          update: {
            seqNo: row.seq_no ? String(row.seq_no) : null,
            storeName: String(row.store_name ?? ''),
            freezerId: row.freezer_id ? String(row.freezer_id) : null,
            phoneRaw: rawPhone,
            phoneValid: true,
            exchangeCount: row.exchange_count ? Number(row.exchange_count) : null,
            awardCount: row.award_count ? Number(row.award_count) : null,
            totalCount: row.total_count ? Number(row.total_count) : null,
          },
          create: {
            seqNo: row.seq_no ? String(row.seq_no) : null,
            storeName: String(row.store_name ?? ''),
            freezerId: row.freezer_id ? String(row.freezer_id) : null,
            phoneRaw: rawPhone,
            phoneNorm: normalized,
            phoneValid: true,
            exchangeCount: row.exchange_count ? Number(row.exchange_count) : null,
            awardCount: row.award_count ? Number(row.award_count) : null,
            totalCount: row.total_count ? Number(row.total_count) : null,
            areaId: area.id,
            departmentId: department.id,
          },
        })
        imported++
      } catch (e: unknown) {
        if (e instanceof Error && e.message.includes('Unique constraint')) {
          duplicates++
        } else {
          invalid++
        }
      }
    }

    res.json({ ok: true, data: { imported, invalid, duplicates } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

export default router
