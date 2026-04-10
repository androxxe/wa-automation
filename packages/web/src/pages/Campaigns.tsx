import { Link } from 'react-router-dom'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/utils'
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
  queuedCount: number
  failedCount: number
  alreadyRepliedCount: number
  targetRepliesPerArea: number | null
  areas: { areaId: string }[]
  createdAt: string
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

  const { data: campaigns = [], isLoading } = useQuery<Campaign[]>({
    queryKey: ['campaigns', statusFilter],
    queryFn:  () => apiFetch<Campaign[]>(`/api/campaigns${statusFilter ? `?status=${statusFilter}` : ''}`),
  })

  const cancelMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/campaigns/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['campaigns'] }),
  })

  const handleCancel = (id: string) => {
    if (!confirm('Cancel this campaign?')) return
    cancelMutation.mutate(id)
  }

  const stats = campaigns.reduce(
    (acc, c) => {
      acc.total++
      if (c.status === 'RUNNING') acc.running++
      if (c.status === 'PAUSED') acc.paused++
      acc.queued += c.queuedCount
      acc.failed += c.failedCount
      acc.replies += c.replyCount
      return acc
    },
    { total: 0, running: 0, paused: 0, queued: 0, failed: 0, replies: 0 },
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Campaigns</h2>
          <p className="text-muted-foreground">
            {campaigns.length} total{statusFilter ? ` (${statusFilter})` : ''}
          </p>
        </div>
        <Link
          to="/campaigns/new"
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
          onChange={(e) => setStatusFilter(e.target.value as '' | CampaignStatus)}
          className="text-sm rounded-md border bg-background px-3 py-1.5"
        >
          <option value="">All</option>
          <option value="DRAFT">DRAFT</option>
          <option value="RUNNING">RUNNING</option>
          <option value="PAUSED">PAUSED</option>
          <option value="COMPLETED">COMPLETED</option>
          <option value="CANCELLED">CANCELLED</option>
        </select>
        {statusFilter && (
          <button
            type="button"
            onClick={() => setStatusFilter('')}
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Clear filter
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {[
          ['Shown', String(stats.total), 'text-foreground'],
          ['Running', String(stats.running), 'text-green-700'],
          ['Paused', String(stats.paused), 'text-yellow-700'],
          ['In Queue', String(stats.queued), 'text-blue-700'],
          ['Failed', String(stats.failed), 'text-red-700'],
          ['Replies', String(stats.replies), 'text-emerald-700'],
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
              {['Name', 'Type', 'Month', 'Status', 'Progress', 'Replies', 'Queue / Failed', 'Already Replied', 'Created', 'Actions'].map((h) => (
                <th key={h} className="px-4 py-2.5 text-left font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && (
              <tr><td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">Loading...</td></tr>
            )}
            {!isLoading && campaigns.length === 0 && (
              <tr><td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">No campaigns yet</td></tr>
            )}
            {campaigns.map((c) => {
              const progress    = c.totalCount > 0 ? Math.round((c.sentCount / c.totalCount) * 100) : 0
              const totalTarget = c.targetRepliesPerArea ? c.targetRepliesPerArea * c.areas.length : null
              const targetMet   = totalTarget !== null && c.replyCount >= totalTarget

              return (
                <tr key={c.id} className="hover:bg-accent/50 transition-colors">
                  <td className="px-4 py-2.5 font-medium">
                    <Link to={`/campaigns/${c.id}`} className="hover:underline">{c.name}</Link>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      c.campaignType === 'STIK' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'
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
    </div>
  )
}
