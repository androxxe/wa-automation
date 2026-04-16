import { Router } from 'express'
import { buildResponseWorkbook, writeOutputFiles } from '../lib/exporter'
import { generateAreaReport, generateAllReports } from '../lib/report'
import { buildCampaignReportXlsx, buildAllCampaignsReportXlsx, buildDepartmentReportXlsx } from '../lib/report-xlsx'

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

// GET /api/export/report-xlsx-all — XLSX with all campaigns, one sheet per campaign
router.get('/report-xlsx-all', async (req, res) => {
  try {
    const buffer   = await buildAllCampaignsReportXlsx()
    const date     = new Date().toISOString().slice(0, 10)
    const filename = `laporan_semua_campaign_${date}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(buffer)
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// GET /api/export/report-xlsx-filtered — XLSX with filtered campaigns
router.get('/report-xlsx-filtered', async (req, res) => {
  const { bulan, campaignType } = req.query as Record<string, string>
  try {
    const buffer   = await buildAllCampaignsReportXlsx({ bulan, campaignType })
    const date     = new Date().toISOString().slice(0, 10)
    let filename   = 'laporan_'
    if (bulan && campaignType) {
      filename += `${bulan}_${campaignType}_${date}.xlsx`
    } else if (bulan) {
      filename += `${bulan}_${date}.xlsx`
    } else if (campaignType) {
      filename += `${campaignType}_${date}.xlsx`
    } else {
      filename += `semua_campaign_${date}.xlsx`
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(buffer)
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// GET /api/export/report-xlsx-dept — XLSX organized by department with filtering
router.get('/report-xlsx-dept', async (req, res) => {
  const { bulan, campaignType, categories, jawabans } = req.query as Record<string, string | string[]>

  try {
    // Parse filter arrays from query parameters
    const categoryArray = categories
      ? (typeof categories === 'string' ? [categories] : categories)
      : undefined

    const jawabanArray = jawabans
      ? (typeof jawabans === 'string' ? [jawabans] : jawabans).map((j) => {
        if (j === 'null') return null
        return parseInt(j, 10) as 0 | 1 | null
      })
      : undefined

    const buffer = await buildDepartmentReportXlsx({
      bulan: bulan as string | undefined,
      campaignType: campaignType as string | undefined,
      categories: categoryArray as string[] | undefined,
      jawabans: jawabanArray as (0 | 1 | null)[] | undefined,
    })

    const date = new Date().toISOString().slice(0, 10)
    let filename = 'laporan_departemen_'
    if (bulan && campaignType) {
      filename += `${bulan}_${campaignType}_${date}.xlsx`
    } else if (bulan) {
      filename += `${bulan}_${date}.xlsx`
    } else if (campaignType) {
      filename += `${campaignType}_${date}.xlsx`
    } else {
      filename += `${date}.xlsx`
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(buffer)
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

export default router
