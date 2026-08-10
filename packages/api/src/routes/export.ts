import { Router } from 'express'
import type { Response } from 'express'
import { buildResponseWorkbook, writeOutputFiles } from '../lib/exporter'
import { generateAreaReport, generateAllReports } from '../lib/report'
import { buildCampaignReportXlsx, buildAllCampaignsReportXlsx, buildDepartmentReportXlsx } from '../lib/report-xlsx'
import type { ReportXlsxOptions } from '../lib/report-xlsx'
import { buildReportZip } from '../lib/archive'
import type { ArchivePhoto } from '../lib/archive'

const router: import('express').Router = Router()

/**
 * Build a report and respond as XLSX (legacy, photos embedded) by default,
 * or as ZIP (xlsx at root + photos under screenshots/<campaign>/) when format=zip.
 */
async function sendReport(
  res: Response,
  xlsxName: string,
  builder: (options?: ReportXlsxOptions) => Promise<Buffer>,
  format?: string,
): Promise<void> {
  const zip    = format === 'zip'
  const photos: ArchivePhoto[] = []
  const buffer = await builder(
    zip ? { embedImages: false, onPhoto: (photo) => photos.push(photo) } : undefined,
  )

  if (zip) {
    const zipBuffer = await buildReportZip(buffer, xlsxName, photos)
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${xlsxName.replace(/\.xlsx$/, '.zip')}"`)
    res.send(zipBuffer)
    return
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${xlsxName}"`)
  res.send(buffer)
}

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

// GET /api/export/report-xlsx?campaignId=&format=zip — XLSX with embedded screenshots (legacy) or ZIP with photo folder
router.get('/report-xlsx', async (req, res) => {
  const { campaignId, format } = req.query as Record<string, string | undefined>
  if (!campaignId) {
    res.status(400).json({ ok: false, error: 'campaignId query param is required' })
    return
  }
  try {
    const date     = new Date().toISOString().slice(0, 10)
    const filename = `laporan_${campaignId}_${date}.xlsx`
    await sendReport(res, filename, (options) => buildCampaignReportXlsx(campaignId, options), format)
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// GET /api/export/report-xlsx-all?format=zip — XLSX with all campaigns, one sheet per campaign
router.get('/report-xlsx-all', async (req, res) => {
  const { format } = req.query as Record<string, string | undefined>
  try {
    const date     = new Date().toISOString().slice(0, 10)
    const filename = `laporan_semua_campaign_${date}.xlsx`
    await sendReport(res, filename, (options) => buildAllCampaignsReportXlsx(undefined, options), format)
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// GET /api/export/report-xlsx-filtered?format=zip — XLSX with filtered campaigns
router.get('/report-xlsx-filtered', async (req, res) => {
  const { bulan, campaignType, format } = req.query as Record<string, string | undefined>
  try {
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
    await sendReport(
      res,
      filename,
      (options) => buildAllCampaignsReportXlsx({ bulan, campaignType }, options),
      format,
    )
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// GET /api/export/report-xlsx-dept?format=zip — XLSX organized by department with filtering
router.get('/report-xlsx-dept', async (req, res) => {
  const { bulan, campaignType, categories, jawabans, format } = req.query as Record<string, string | string[]>

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

    await sendReport(
      res,
      filename,
      (options) => buildDepartmentReportXlsx({
        bulan: bulan as string | undefined,
        campaignType: campaignType as string | undefined,
        categories: categoryArray as string[] | undefined,
        jawabans: jawabanArray as (0 | 1 | null)[] | undefined,
      }, options),
      typeof format === 'string' ? format : undefined,
    )
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

export default router
