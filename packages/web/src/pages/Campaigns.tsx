import { Link } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch, apiFetchEnvelope } from '@/lib/utils'
import Pagination from '@/components/Pagination'
import { TYPE_BADGE } from '@/lib/typeBadges'
import type { CampaignStatus } from '@aice/shared'

interface Campaign {
  id: string
  name: string
  bulan: string
  campaignType: string
  status: CampaignStatus
  totalCount: number
  sentCount: number
  replyCount: number
  qualifyingReplyCount: number
  queuedCount: number
  failedCount: number
  alreadyRepliedCount: number
  verifiedLeft: number
  verifiedTotal: number
  targetRepliesPerArea: number | null
  areas: { areaId: string }[]
  createdAt: string
}

interface CampaignStats {
  total:    number
  running:  number
  paused:   number
  queued:   number
  failed:   number
  replies:  number
  qualify:  number
}

interface CampaignsMeta {
  total:  number
  page:   number
  limit:  number
  pages:  number
  stats:  CampaignStats
  facets: { months: string[]; types: string[] }
}

const PAGE_SIZE = 50

const EMPTY_STATS: CampaignStats = {
  total: 0, running: 0, paused: 0, queued: 0, failed: 0, replies: 0, qualify: 0,
}

const STATUS_COLORS: Record<CampaignStatus, string> = {
  DRAFT:     'bg-gray-100 text-gray-600',
  RUNNING:   'bg-green-100 text-green-700',
  PAUSED:    'bg-yellow-100 text-yellow-700',
  COMPLETED: 'bg-blue-100 text-blue-700',
  CANCELLED: 'bg-red-100 text-red-600',
}

export default function Campaigns() {
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<'' | CampaignStatus>('')
  const [bulanFilter, setBulanFilter] = useState('')
  const [typeFilter,  setTypeFilter]  = useState('')
  const [page,        setPage]        = useState(1)

  const { data, isLoading } = useQuery({
    queryKey: ['campaigns', statusFilter, bulanFilter, typeFilter, page],
    queryFn:  () => {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), includeVerified: '1' })
      if (statusFilter) params.set('status', statusFilter)
      if (bulanFilter)  params.set('bulan',  bulanFilter)
      if (typeFilter)   params.set('campaignType', typeFilter)
      return apiFetchEnvelope<Campaign[], CampaignsMeta>(`/api/campaigns?${params}`)
    },
    placeholderData: (prev) => prev,
  })

  const campaigns = data?.data ?? []
  const total     = data?.total ?? 0
  const pages     = data?.pages ?? 1
  const stats     = data?.stats ?? EMPTY_STATS
  const uniqueMonths = data?.facets.months ?? []
  const uniqueTypes  = data?.facets.types  ?? []

  // Filters reset to page 1, but the set can also shrink after a cancel.
  useEffect(() => {
    const lastPage = data?.pages
    if (lastPage !== undefined && lastPage > 0 && page > lastPage) setPage(lastPage)
  }, [data?.pages, page])

  function updateFilter<T>(setter: (value: T) => void) {
    return (value: T) => { setter(value); setPage(1) }
  }

  const cancelMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/campaigns/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['campaigns'] }),
  })

  const handleCancel = (id: string) => {
    if (!confirm('Cancel this campaign?')) return
    cancelMutation.mutate(id)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Campaigns</h2>
          <p className="text-muted-foreground">
            {total} total{[statusFilter, bulanFilter, typeFilter].filter(Boolean).length > 0
              ? ` (${[statusFilter, bulanFilter, typeFilter].filter(Boolean).join(' · ')})`
              : ''}
          </p>
        </div>
        <Link
          to="/campaigns/new-bulk"
          className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md"
        >
          New Campaign
        </Link>
      </div>

      <div className="flex items-center gap-3">
        <label htmlFor="campaign-status-filter" className="text-sm text-muted-foreground">Status</label>
        <select
          id="campaign-status-filter"
          value={statusFilter}
          onChange={(e) => updateFilter(setStatusFilter)(e.target.value as '' | CampaignStatus)}
          className="text-sm rounded-md border bg-background px-3 py-1.5"
        >
          <option value="">All</option>
          <option value="DRAFT">DRAFT</option>
          <option value="RUNNING">RUNNING</option>
          <option value="PAUSED">PAUSED</option>
          <option value="COMPLETED">COMPLETED</option>
          <option value="CANCELLED">CANCELLED</option>
        </select>
        <select
          id="campaign-type-filter"
          value={typeFilter}
          onChange={(e) => updateFilter(setTypeFilter)(e.target.value)}
          className="text-sm rounded-md border bg-background px-3 py-1.5"
        >
          <option value="">All Types</option>
          {uniqueTypes.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select
          id="campaign-month-filter"
          value={bulanFilter}
          onChange={(e) => updateFilter(setBulanFilter)(e.target.value)}
          className="text-sm rounded-md border bg-background px-3 py-1.5"
        >
          <option value="">All Months</option>
          {uniqueMonths.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
        {(statusFilter || typeFilter || bulanFilter) && (
          <button
            type="button"
            onClick={() => { setStatusFilter(''); setTypeFilter(''); setBulanFilter(''); setPage(1) }}
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-7 gap-3">
        {[
          ['Shown', String(stats.total), 'text-foreground'],
          ['Running', String(stats.running), 'text-green-700'],
          ['Paused', String(stats.paused), 'text-yellow-700'],
          ['In Queue', String(stats.queued), 'text-blue-700'],
          ['Failed', String(stats.failed), 'text-red-700'],
          ['Replies', String(stats.replies), 'text-emerald-700'],
          ['Qualify', String(stats.qualify), 'text-indigo-700'],
        ].map(([label, value, color]) => (
          <div key={label} className="rounded-lg border bg-card px-4 py-3">
            <p className={`text-2xl font-bold ${color}`}>{value}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground text-xs uppercase tracking-wider">
            <tr>
              {['Name', 'Type', 'Month', 'Status', 'Progress', 'Replies', 'Queue / Failed', 'Already Replied', 'Verified Left', 'Created', 'Actions'].map((h) => (
                <th key={h} className="px-4 py-2.5 text-left font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && (
              <tr><td colSpan={11} className="px-4 py-8 text-center text-muted-foreground">Loading...</td></tr>
            )}
            {!isLoading && campaigns.length === 0 && (
              <tr><td colSpan={11} className="px-4 py-8 text-center text-muted-foreground">No campaigns yet</td></tr>
            )}
            {campaigns.map((c) => {
              const progress    = c.totalCount > 0 ? Math.round((c.sentCount / c.totalCount) * 100) : 0
              const totalTarget = c.targetRepliesPerArea ? c.targetRepliesPerArea * c.areas.length : null
              const targetMet   = totalTarget !== null && c.qualifyingReplyCount >= totalTarget

              return (
                <tr key={c.id} className="hover:bg-accent/50 transition-colors">
                  <td className="px-4 py-2.5 font-medium">
                    <Link to={`/campaigns/${c.id}`} className="hover:underline">{c.name}</Link>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      TYPE_BADGE[c.campaignType] ?? 'bg-gray-100 text-gray-700'
                    }`}>
                      {c.campaignType}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{c.bulan}</td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[c.status]}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-primary rounded-full" style={{ width: `${progress}%` }} />
                      </div>
                      <span className="text-xs text-muted-foreground">{c.sentCount}/{c.totalCount}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className={`font-semibold ${c.replyCount > 0 ? 'text-green-600' : 'text-muted-foreground'}`}>
                        {c.replyCount}
                      </span>
                      {totalTarget !== null && (
                        <span className="text-muted-foreground text-xs">/ {totalTarget}</span>
                      )}
                      {targetMet && <span className="text-xs text-green-600 font-bold">✓</span>}
                      {c.qualifyingReplyCount > 0 && (
                        <span
                          className="text-xs text-muted-foreground"
                          title="Replies matching the send config (Any reply / Only YES / YES or NO)"
                        >
                          · {c.qualifyingReplyCount} qualify
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <span className={`text-xs font-semibold ${c.queuedCount > 0 ? 'text-blue-700' : 'text-muted-foreground'}`}>
                      Q {c.queuedCount}
                    </span>
                    <span className="text-muted-foreground text-xs mx-1">/</span>
                    <span className={`text-xs font-semibold ${c.failedCount > 0 ? 'text-red-700' : 'text-muted-foreground'}`}>
                      F {c.failedCount}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`font-semibold ${c.alreadyRepliedCount > 0 ? 'text-emerald-600' : 'text-muted-foreground'}`}
                      title={`Unique contacts who replied for ${c.bulan} ${c.campaignType}`}
                    >
                      {c.alreadyRepliedCount}
                    </span>
                    <span className="text-muted-foreground text-xs ml-1">
                      {c.bulan} · {c.campaignType}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`font-semibold ${c.verifiedLeft > 0 ? 'text-sky-600' : 'text-muted-foreground'}`}
                      title={`${c.verifiedLeft} of ${c.verifiedTotal} verified contacts not yet messaged in this campaign`}
                    >
                      {c.verifiedLeft}
                    </span>
                    <span className="text-muted-foreground text-xs ml-1">
                      / {c.verifiedTotal} left
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground text-xs">
                    {new Date(c.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <Link to={`/campaigns/${c.id}`} className="text-xs text-primary hover:underline">View</Link>
                      {['DRAFT', 'RUNNING', 'PAUSED'].includes(c.status) && (
                        <button
                          type="button"
                          onClick={() => handleCancel(c.id)}
                          disabled={cancelMutation.isPending}
                          className="text-xs text-destructive hover:underline disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        pages={pages}
        total={total}
        limit={PAGE_SIZE}
        onPageChange={setPage}
        itemLabel="campaigns"
      />
    </div>
  )
}
