import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/utils'

interface Campaign {
  id: string
  name: string
  bulan: string
  campaignType: string
}

const CAMPAIGN_TYPES = ['STIK', 'KARDUS']
const CATEGORIES = ['confirmed', 'denied', 'question', 'unclear', 'invalid', 'other', '']
const CATEGORY_LABELS: Record<string, string> = {
  confirmed: 'Confirmed',
  denied: 'Denied',
  question: 'Question',
  unclear: 'Unclear',
  invalid: 'Invalid',
  other: 'Other',
  '': 'No Reply',
}
const JAWABANS = ['1', '0', 'null']
const JAWABAN_LABELS: Record<string, string> = {
  '1': 'Ya (1)',
  '0': 'Tidak (0)',
  'null': 'Tidak Jelas',
}

export default function Export() {
  const [selectedMonth, setSelectedMonth] = useState<string>('')
  const [selectedType, setSelectedType] = useState<string>('')
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(
    new Set(CATEGORIES)
  )
  const [selectedJawabans, setSelectedJawabans] = useState<Set<string>>(
    new Set(JAWABANS)
  )
  const [exportType, setExportType] = useState<'campaign' | 'department'>('campaign')
  const [downloading, setDownloading] = useState(false)

  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey: ['campaigns'],
    queryFn: () => apiFetch<Campaign[]>('/api/campaigns'),
  })

  // Get unique months and types from campaigns
  const months = Array.from(new Set(campaigns.map((c) => c.bulan))).sort()
  const types = Array.from(new Set(campaigns.map((c) => c.campaignType))).sort()

  // Filter campaigns based on selections
  const filteredCampaigns = campaigns.filter((c) => {
    if (selectedMonth && c.bulan !== selectedMonth) return false
    if (selectedType && c.campaignType !== selectedType) return false
    return true
  })

  const toggleCategory = (category: string) => {
    const newSet = new Set(selectedCategories)
    if (newSet.has(category)) {
      newSet.delete(category)
    } else {
      newSet.add(category)
    }
    setSelectedCategories(newSet)
  }

  const toggleJawaban = (jawaban: string) => {
    const newSet = new Set(selectedJawabans)
    if (newSet.has(jawaban)) {
      newSet.delete(jawaban)
    } else {
      newSet.add(jawaban)
    }
    setSelectedJawabans(newSet)
  }

  const handleDownloadFiltered = async () => {
    setDownloading(true)
    try {
      const params = new URLSearchParams()
      if (selectedMonth) params.append('bulan', selectedMonth)
      if (selectedType) params.append('campaignType', selectedType)

      // Add category filters
      if (selectedCategories.size > 0 && selectedCategories.size < CATEGORIES.length) {
        selectedCategories.forEach((cat) => {
          params.append('categories', cat)
        })
      }

      // Add jawaban filters
      if (selectedJawabans.size > 0 && selectedJawabans.size < JAWABANS.length) {
        selectedJawabans.forEach((jawaban) => {
          params.append('jawabans', jawaban)
        })
      }

      const endpoint =
        exportType === 'campaign'
          ? `/api/export/report-xlsx-filtered?${params}`
          : `/api/export/report-xlsx-dept?${params}`

      const res = await fetch(endpoint)
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        alert(`Download failed: ${(err as { error: string }).error}`)
        return
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const filename = buildFilename(selectedMonth, selectedType, exportType)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      alert(`Download failed: ${String(err)}`)
    } finally {
      setDownloading(false)
    }
  }

  const buildFilename = (
    month?: string,
    type?: string,
    exportTypeParam?: string
  ): string => {
    const date = new Date().toISOString().slice(0, 10)
    const prefix = exportTypeParam === 'department' ? 'laporan_departemen_' : 'laporan_'

    if (!month && !type) return `${prefix}semua_campaign_${date}.xlsx`
    if (month && !type) return `${prefix}${month}_${date}.xlsx`
    if (!month && type) return `${prefix}${type}_${date}.xlsx`
    return `${prefix}${month}_${type}_${date}.xlsx`
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Export Reports</h2>
        <p className="text-muted-foreground">Download campaign reports with advanced filtering</p>
      </div>

      {/* Export Type Selection */}
      <div className="rounded-lg border bg-card p-6 space-y-3">
        <div>
          <p className="text-sm font-medium">Export Format</p>
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="radio"
              name="exportType"
              value="campaign"
              checked={exportType === 'campaign'}
              onChange={(e) => setExportType(e.target.value as 'campaign' | 'department')}
              className="w-4 h-4"
            />
            <span className="text-sm">Campaign-Based (one sheet per campaign)</span>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="radio"
              name="exportType"
              value="department"
              checked={exportType === 'department'}
              onChange={(e) => setExportType(e.target.value as 'campaign' | 'department')}
              className="w-4 h-4"
            />
            <span className="text-sm">Department-Based (one sheet per department)</span>
          </label>
        </div>
      </div>

      {/* Basic Filters */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Month Filter */}
        <div className="rounded-lg border bg-card p-6 space-y-3">
          <div>
            <label htmlFor="month-select" className="text-sm font-medium">
              Filter by Month (Optional)
            </label>
            <p className="text-xs text-muted-foreground mt-0.5">Leave empty to include all months</p>
          </div>
          <select
            id="month-select"
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="w-full text-sm rounded-md border bg-background px-3 py-2"
          >
            <option value="">— All Months —</option>
            {months.map((month) => (
              <option key={month} value={month}>
                {month}
              </option>
            ))}
          </select>
        </div>

        {/* Campaign Type Filter */}
        <div className="rounded-lg border bg-card p-6 space-y-3">
          <div>
            <label htmlFor="type-select" className="text-sm font-medium">
              Filter by Type (Optional)
            </label>
            <p className="text-xs text-muted-foreground mt-0.5">Leave empty to include both STIK & KARDUS</p>
          </div>
          <select
            id="type-select"
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
            className="w-full text-sm rounded-md border bg-background px-3 py-2"
          >
            <option value="">— All Types —</option>
            {types.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Advanced Filters */}
      <div className="space-y-4">
        {/* Category Filter */}
        <div className="rounded-lg border bg-card p-6 space-y-3">
          <div>
            <p className="text-sm font-medium">Claude Category (Optional)</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Select which response categories to include in the report
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {CATEGORIES.map((category) => (
              <label key={category} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedCategories.has(category)}
                  onChange={() => toggleCategory(category)}
                  className="w-4 h-4 rounded"
                />
                <span className="text-sm">{CATEGORY_LABELS[category]}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Jawaban Filter */}
        <div className="rounded-lg border bg-card p-6 space-y-3">
          <div>
            <p className="text-sm font-medium">Jawaban Value (Optional)</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Select which jawaban values to include (customer responses)
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {JAWABANS.map((jawaban) => (
              <label key={jawaban} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedJawabans.has(jawaban)}
                  onChange={() => toggleJawaban(jawaban)}
                  className="w-4 h-4 rounded"
                />
                <span className="text-sm">{JAWABAN_LABELS[jawaban]}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Preview */}
      <div className="rounded-lg border bg-card p-6 space-y-4">
        <div>
          <h3 className="font-semibold text-sm mb-3">Export Preview</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            <div className="p-3 rounded border bg-muted/50">
              <p className="text-xs text-muted-foreground">Campaigns</p>
              <p className="text-lg font-semibold">{filteredCampaigns.length}</p>
            </div>
            <div className="p-3 rounded border bg-muted/50">
              <p className="text-xs text-muted-foreground">Month(s)</p>
              <p className="text-lg font-semibold">{selectedMonth || 'All'}</p>
            </div>
            <div className="p-3 rounded border bg-muted/50">
              <p className="text-xs text-muted-foreground">Type(s)</p>
              <p className="text-lg font-semibold">{selectedType || 'All'}</p>
            </div>
            <div className="p-3 rounded border bg-muted/50">
              <p className="text-xs text-muted-foreground">Format</p>
              <p className="text-lg font-semibold capitalize">{exportType}</p>
            </div>
          </div>
        </div>

        {filteredCampaigns.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-2">Campaigns to export:</p>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {filteredCampaigns.map((c) => (
                <div key={c.id} className="text-xs flex items-center justify-between p-2 bg-muted/30 rounded">
                  <span className="font-medium">{c.name}</span>
                  <span className="text-muted-foreground">
                    {c.bulan} · {c.campaignType}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {filteredCampaigns.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">
            No campaigns match the selected filters
          </p>
        )}
      </div>

      {/* Download Button */}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={handleDownloadFiltered}
          disabled={downloading || filteredCampaigns.length === 0}
          className="flex-1 px-6 py-3 rounded-md bg-primary text-primary-foreground font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
        >
          {downloading ? 'Generating…' : 'Download XLSX Report'}
        </button>
      </div>

      {/* Export Info */}
      <div className="rounded-lg border bg-muted/20 p-4 space-y-2 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Export Details:</p>
        <ul className="list-disc list-inside space-y-1 text-xs">
          {exportType === 'campaign' ? (
            <>
              <li>Each campaign gets its own sheet in the Excel file</li>
              <li>Sheet names include campaign name and export date</li>
              <li>Organized by area within each campaign sheet</li>
            </>
          ) : (
            <>
              <li>Each department gets its own sheet in the Excel file</li>
              <li>Multiple campaigns appear in each department sheet (separated by empty row)</li>
              <li>Filtered by selected Claude categories and jawaban values</li>
            </>
          )}
          <li>All screenshots are embedded in the file</li>
          <li>Summary sheet shows global statistics</li>
          <li>Data includes: store name, phone, area, department, message, reply, category</li>
        </ul>
      </div>
    </div>
  )
}
