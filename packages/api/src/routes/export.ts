import { Router } from 'express'
import { buildResponseWorkbook, writeOutputFiles } from '../lib/exporter'

const router = Router()

// GET /api/export/responses — download xlsx
router.get('/responses', async (req, res) => {
  const { startDate, endDate, departmentId, areaId } = req.query as Record<string, string>
  try {
    const buffer = await buildResponseWorkbook({ startDate, endDate, departmentId, areaId })
    const filename = `responses_${new Date().toISOString().slice(0, 10)}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(buffer)
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/export/write — write files to OUTPUT_FOLDER
router.post('/write', async (_req, res) => {
  try {
    await writeOutputFiles()
    res.json({ ok: true, data: null })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

export default router
