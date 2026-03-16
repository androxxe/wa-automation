import { Router } from 'express'
import { buildResponseWorkbook, writeOutputFiles } from '../lib/exporter'
import { generateAreaReport, generateAllReports } from '../lib/report'
import { buildCampaignReportXlsx } from '../lib/report-xlsx'

const router: import('express').Router = Router()

// GET /api/export/responses
router.get('/responses', async (req, res) => {
  const { startDate, endDate, departmentId, areaId } = req.query as Record<string, string>
  try {
    const buffer   = await buildResponseWorkbook({ startDate, endDate, departmentId, areaId })
    const filename = `responses_${new Date().toISOString().slice(0, 10)}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(buffer)
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/export/write
router.post('/write', async (_req, res) => {
  try {
    await writeOutputFiles()
    res.json({ ok: true, data: null })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/export/report-area — triggered fire-and-forget by the worker after send/reply
router.post('/report-area', async (req, res) => {
  const { areaId, bulan, campaignType } = req.body as {
    areaId:       string
    bulan:        string
    campaignType: string
  }
  if (!areaId || !bulan || !campaignType) {
    res.status(400).json({ ok: false, error: 'areaId, bulan, campaignType required' })
    return
  }
  try {
    generateAreaReport(areaId, bulan, campaignType).catch((err) =>
      console.error('[report] generate failed:', err),
    )
    res.json({ ok: true, data: null })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// POST /api/export/report — regenerate CSV for one (area+bulan+type) or all
router.post('/report', async (req, res) => {
  const { areaId, bulan, campaignType } = req.body as {
    areaId?:       string
    bulan?:        string
    campaignType?: string
  }
  try {
    if (areaId && bulan && campaignType) {
      const csvPath = await generateAreaReport(areaId, bulan, campaignType)
      res.json({ ok: true, data: { path: csvPath } })
    } else {
      const paths = await generateAllReports()
      res.json({ ok: true, data: { paths, count: paths.length } })
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// GET /api/export/report-xlsx?campaignId= — XLSX with embedded screenshots
router.get('/report-xlsx', async (req, res) => {
  const { campaignId } = req.query as { campaignId?: string }
  if (!campaignId) {
    res.status(400).json({ ok: false, error: 'campaignId query param is required' })
    return
  }
  try {
    const buffer   = await buildCampaignReportXlsx(campaignId)
    const date     = new Date().toISOString().slice(0, 10)
    const filename = `laporan_${campaignId}_${date}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(buffer)
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

export default router
