import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/utils'
import type { ReplyCategory } from '@aice/shared'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Reply {
  id:              string
  body:            string
  claudeCategory:  ReplyCategory | null
  claudeSentiment: string | null
  claudeSummary:   string | null
  jawaban:         number | null   // 1 = ya, 0 = tidak, null = unclear
  screenshotPath:  string | null
  receivedAt:      string
  message: {
    id:         string
    phone:      string
    sentAt:     string | null
    body:       string
    campaignId: string
    campaign:   { id: string; name: string; bulan: string; campaignType: string }
    contact: {
      storeName:  string
      department: { name: string }
      area:       { name: string }
    }
  }
}

interface RepliesResponse {
  replies: Reply[]
  total:   number
  page:    number
  limit:   number
  pages:   number
  stats: {
    total:     number
    confirmed: number
    denied:    number
    question:  number
    unclear:   number
    other:     number
  }
}

interface Campaign {
  id:           string
  name:         string
  bulan:        string
  campaignType: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  confirmed: 'bg-green-100 text-green-700',
  denied:    'bg-red-100 text-red-600',
  question:  'bg-yellow-100 text-yellow-700',
  unclear:   'bg-gray-100 text-gray-600',
  other:     'bg-blue-100 text-blue-700',
}

const SENTIMENT_COLORS: Record<string, string> = {
  positive: 'bg-green-400',
  neutral:  'bg-gray-400',
  negative: 'bg-red-400',
}

const CATEGORIES: { value: string; label: string }[] = [
  { value: '',          label: 'All Categories' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'denied',    label: 'Denied' },
  { value: 'question',  label: 'Question' },
  { value: 'unclear',   label: 'Unclear' },
  { value: 'other',     label: 'Other' },
]

const JAWABAN_OPTIONS: { value: string; label: string }[] = [
  { value: '',     label: 'All Jawaban' },
  { value: '1',    label: 'Ya' },
  { value: '0',    label: 'Tidak' },
  { value: 'null', label: 'Tidak Jelas' },
]

// ─── Screenshot Modal ─────────────────────────────────────────────────────────

function ScreenshotModal({ path, onClose }: { path: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <button
        type="button"
        aria-label="Close screenshot"
        className="absolute inset-0 w-full h-full cursor-default"
        onClick={onClose}
      />
      <div className="relative max-w-2xl w-full mx-4 z-10">
        <button
          type="button"
          onClick={onClose}
          className="absolute -top-8 right-0 text-white text-sm opacity-80 hover:opacity-100"
        >
          Close ✕
        </button>
        <img
          src={`/api/replies/screenshot?p=${encodeURIComponent(path)}`}
          alt="reply screenshot"
          className="w-full rounded-lg shadow-2xl"
        />
      </div>
    </div>
  )
}

// ─── Campaign Combobox ────────────────────────────────────────────────────────

function CampaignPicker({
  value,
  onChange,
  campaigns,
  placeholder = '— Pilih campaign —',
  className = '',
}: {
  value:      string
  onChange:   (id: string) => void
  campaigns:  Campaign[]
  placeholder?: string
  className?: string
}) {
  const [search, setSearch] = useState('')
  const [open,   setOpen]   = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const selected = campaigns.find((c) => c.id === value)
  const filtered = campaigns.filter((c) => {
    const q = search.toLowerCase()
    return (
      c.name.toLowerCase().includes(q) ||
      c.bulan.toLowerCase().includes(q) ||
      c.campaignType.toLowerCase().includes(q)
    )
  })

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [])

  return (
    <div className={`relative ${className}`} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-sm rounded-md border bg-background px-2 py-1.5 text-left flex items-center justify-between gap-2"
      >
        <span className={selected ? 'truncate' : 'text-muted-foreground truncate'}>
          {selected
            ? `${selected.name} — ${selected.bulan} — ${selected.campaignType}`
            : placeholder}
        </span>
        <span className="text-xs opacity-60 shrink-0">▾</span>
      </button>
      {open && (
        <div className="absolute z-30 left-0 top-full mt-1 w-full min-w-[280px] rounded-lg border bg-popover shadow-md">
          <div className="p-2 border-b">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari campaign…"
              ref={(el) => { if (el) el.focus() }}
              className="w-full text-sm rounded border bg-background px-2 py-1 outline-none"
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            {value && (
              <button
                type="button"
                className="w-full text-left text-sm px-3 py-2 hover:bg-accent text-muted-foreground"
                onClick={() => { onChange(''); setOpen(false); setSearch('') }}
              >
                — Hapus pilihan —
              </button>
            )}
            {filtered.length === 0 && (
              <p className="text-sm text-muted-foreground px-3 py-4 text-center">
                Tidak ditemukan
              </p>
            )}
            {filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`w-full text-left text-sm px-3 py-2 hover:bg-accent ${c.id === value ? 'bg-accent/60 font-medium' : ''}`}
                onClick={() => { onChange(c.id); setOpen(false); setSearch('') }}
              >
                <span className="font-medium">{c.name}</span>
                <span className="text-muted-foreground text-xs ml-1">
                  — {c.bulan} — {c.campaignType}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Export Dropdown ──────────────────────────────────────────────────────────

function ExportDropdown({ campaignId, campaigns }: { campaignId: string; campaigns: Campaign[] }) {
  const [open, setOpen]           = useState(false)
  const [downloading, setDl]      = useState(false)
  const [selCampaign, setSelCamp] = useState(campaignId)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setSelCamp(campaignId)
  }, [campaignId])

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  async function handleDownload() {
    if (!selCampaign) return
    setDl(true)
    setOpen(false)
    try {
      const res = await fetch(`/api/export/report-xlsx?campaignId=${selCampaign}`)
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        alert(`Download failed: ${(err as { error: string }).error}`)
        return
      }
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const c    = campaigns.find((x) => x.id === selCampaign)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `laporan_${c?.campaignType ?? ''}_${c?.bulan ?? ''}_${new Date().toISOString().slice(0, 10)}.xlsx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      alert(`Download failed: ${String(err)}`)
    } finally {
      setDl(false)
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={downloading}
        className="text-sm px-4 py-2 rounded-md border flex items-center gap-1.5 disabled:opacity-50"
      >
        {downloading ? 'Generating…' : 'Export'}
        <span className="text-xs opacity-60">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-72 rounded-lg border bg-popover shadow-md z-20 p-1">
          {/* Export all */}
          <button
            type="button"
            className="w-full text-left text-sm px-3 py-2 rounded hover:bg-accent"
            onClick={() => { window.open('/api/export/responses', '_blank'); setOpen(false) }}
          >
            Export all responses (XLSX)
          </button>
          <button
            type="button"
            className="w-full text-left text-sm px-3 py-2 rounded hover:bg-accent"
            onClick={() => {
              apiFetch('/api/export/write', { method: 'POST' })
                .then(() => alert('Files written to OUTPUT_FOLDER'))
                .catch(console.error)
              setOpen(false)
            }}
          >
            Write to Output Folder
          </button>
          <div className="border-t my-1" />
          {/* Per-campaign report */}
          <p className="text-xs text-muted-foreground px-3 py-1">Download report (with screenshots)</p>
          <div className="px-3 pb-2 flex flex-col gap-2">
            <CampaignPicker
              value={selCampaign}
              onChange={setSelCamp}
              campaigns={campaigns}
            />
            <button
              type="button"
              onClick={handleDownload}
              disabled={!selCampaign || downloading}
              className="w-full text-sm px-3 py-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-50"
            >
              {downloading ? 'Generating…' : 'Download XLSX'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Stats Bar ────────────────────────────────────────────────────────────────

function StatsBar({ stats }: { stats: RepliesResponse['stats'] }) {
  const items = [
    { label: 'Total',     value: stats.total,     color: 'text-foreground' },
    { label: 'Confirmed', value: stats.confirmed, color: 'text-green-600'  },
    { label: 'Denied',    value: stats.denied,    color: 'text-red-600'    },
    { label: 'Question',  value: stats.question,  color: 'text-yellow-600' },
    { label: 'Unclear',   value: stats.unclear,   color: 'text-gray-500'   },
    { label: 'Other',     value: stats.other,     color: 'text-blue-600'   },
  ]
  return (
    <div className="grid grid-cols-6 gap-3">
      {items.map(({ label, value, color }) => (
        <div key={label} className="rounded-lg border bg-card px-4 py-3 text-center">
          <p className={`text-2xl font-bold ${color}`}>{value}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
        </div>
      ))}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Responses() {
  const [filterCampaignId, setFilterCampaignId] = useState('')
  const [filterCategory,   setFilterCategory]   = useState('')
  const [filterJawaban,    setFilterJawaban]     = useState('')
  const [page,             setPage]              = useState(1)
  const [screenshot,       setScreenshot]        = useState<string | null>(null)

  // Reset to page 1 whenever filters change
  function updateFilter<T>(setter: (v: T) => void) {
    return (v: T) => { setter(v); setPage(1) }
  }

  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey: ['campaigns'],
    queryFn:  () => apiFetch<Campaign[]>('/api/campaigns'),
  })

  const repliesQuery = useQuery<RepliesResponse>({
    queryKey: ['replies', filterCampaignId, filterCategory, filterJawaban, page],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: '50' })
      if (filterCampaignId) params.set('campaignId', filterCampaignId)
      if (filterCategory)   params.set('category',   filterCategory)
      if (filterJawaban)    params.set('jawaban',     filterJawaban)
      return apiFetch<RepliesResponse>(`/api/replies?${params}`)
    },
    placeholderData: (prev) => prev,
  })

  const data    = repliesQuery.data
  const replies = data?.replies ?? []
  const stats   = data?.stats ?? { total: 0, confirmed: 0, denied: 0, question: 0, unclear: 0, other: 0 }
  const pages   = data?.pages ?? 1

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Responses</h2>
          <p className="text-muted-foreground">Incoming replies analyzed by Claude</p>
        </div>
        <ExportDropdown campaignId={filterCampaignId} campaigns={campaigns} />
      </div>

      {/* Stats bar */}
      <StatsBar stats={stats} />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <CampaignPicker
          value={filterCampaignId}
          onChange={updateFilter(setFilterCampaignId)}
          campaigns={campaigns}
          placeholder="All Campaigns"
          className="w-64"
        />

        <select
          value={filterCategory}
          onChange={(e) => updateFilter(setFilterCategory)(e.target.value)}
          className="text-sm rounded-md border bg-background px-3 py-1.5"
        >
          {CATEGORIES.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <select
          value={filterJawaban}
          onChange={(e) => updateFilter(setFilterJawaban)(e.target.value)}
          className="text-sm rounded-md border bg-background px-3 py-1.5"
        >
          {JAWABAN_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {(filterCampaignId || filterCategory || filterJawaban) && (
          <button
            type="button"
            onClick={() => { setFilterCampaignId(''); setFilterCategory(''); setFilterJawaban(''); setPage(1) }}
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Clear filters
          </button>
        )}

        {repliesQuery.isFetching && (
          <span className="text-xs text-muted-foreground ml-auto">Loading…</span>
        )}
      </div>

      {/* Table */}
      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground text-xs uppercase tracking-wider">
            <tr>
              {['Campaign', 'Store', 'Area / Dept', 'Message Sent', 'Reply', 'Summary', 'Jawaban', 'Category', 'Time', ''].map((h) => (
                <th key={h} className="px-3 py-2.5 text-left font-medium whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {replies.length === 0 && !repliesQuery.isFetching && (
              <tr>
                <td colSpan={10} className="px-4 py-10 text-center text-muted-foreground">
                  No replies yet
                </td>
              </tr>
            )}
            {replies.map((r) => (
              <tr key={r.id} className="hover:bg-accent/50 align-top">
                {/* Campaign */}
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <p className="font-medium text-xs leading-tight">{r.message.campaign.name}</p>
                  <p className="text-muted-foreground text-xs">{r.message.campaign.bulan} · {r.message.campaign.campaignType}</p>
                </td>

                {/* Store */}
                <td className="px-3 py-2.5 font-medium whitespace-nowrap">
                  {r.message.contact.storeName}
                </td>

                {/* Area / Dept */}
                <td className="px-3 py-2.5 text-muted-foreground text-xs whitespace-nowrap">
                  <p>{r.message.contact.area.name}</p>
                  <p>{r.message.contact.department.name}</p>
                </td>

                {/* Message Sent */}
                <td className="px-3 py-2.5 max-w-[160px]">
                  <p className="truncate text-xs text-muted-foreground" title={r.message.body}>
                    {r.message.body.slice(0, 60)}{r.message.body.length > 60 ? '…' : ''}
                  </p>
                </td>

                {/* Reply */}
                <td className="px-3 py-2.5 max-w-[180px]">
                  <p className="truncate" title={r.body}>
                    {r.body.slice(0, 70)}{r.body.length > 70 ? '…' : ''}
                  </p>
                </td>

                {/* Claude Summary */}
                <td className="px-3 py-2.5 max-w-[200px]">
                  {r.claudeSummary ? (
                    <p className="text-xs text-muted-foreground italic leading-snug" title={r.claudeSummary}>
                      {r.claudeSummary.slice(0, 80)}{r.claudeSummary.length > 80 ? '…' : ''}
                    </p>
                  ) : (
                    <span className="text-muted-foreground/40 text-xs">—</span>
                  )}
                </td>

                {/* Jawaban */}
                <td className="px-3 py-2.5 whitespace-nowrap">
                  {r.jawaban === 1 && (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700">Ya</span>
                  )}
                  {r.jawaban === 0 && (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-600">Tidak</span>
                  )}
                  {r.jawaban === null && (
                    <span className="text-muted-foreground/40 text-xs">—</span>
                  )}
                </td>

                {/* Category */}
                <td className="px-3 py-2.5 whitespace-nowrap">
                  {r.claudeCategory ? (
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex items-center gap-1 w-fit ${CATEGORY_COLORS[r.claudeCategory] ?? ''}`}>
                      {r.claudeSentiment && (
                        <span
                          className={`inline-block w-1.5 h-1.5 rounded-full ${SENTIMENT_COLORS[r.claudeSentiment] ?? 'bg-gray-400'}`}
                          title={r.claudeSentiment}
                        />
                      )}
                      {r.claudeCategory}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40 text-xs">—</span>
                  )}
                </td>

                {/* Time */}
                <td className="px-3 py-2.5 text-muted-foreground text-xs whitespace-nowrap">
                  {new Date(r.receivedAt).toLocaleString('id-ID', {
                    day:    '2-digit',
                    month:  'short',
                    year:   'numeric',
                    hour:   '2-digit',
                    minute: '2-digit',
                  })}
                </td>

                {/* Screenshot */}
                <td className="px-3 py-2.5">
                  {r.screenshotPath ? (
                    <button
                      type="button"
                      onClick={() => setScreenshot(r.screenshotPath)}
                      aria-label="View screenshot"
                      className="text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
                      </svg>
                    </button>
                  ) : (
                    <span aria-hidden="true" className="text-muted-foreground/20">
                      <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
                      </svg>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {data ? `${(page - 1) * 50 + 1}–${Math.min(page * 50, data.total)} of ${data.total} replies` : ''}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-1 rounded-md border disabled:opacity-40 hover:bg-accent"
            >
              ‹ Prev
            </button>
            <span className="px-2">Page {page} / {pages}</span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={page >= pages}
              className="px-3 py-1 rounded-md border disabled:opacity-40 hover:bg-accent"
            >
              Next ›
            </button>
          </div>
        </div>
      )}

      {/* Screenshot modal */}
      {screenshot && (
        <ScreenshotModal path={screenshot} onClose={() => setScreenshot(null)} />
      )}
    </div>
  )
}
