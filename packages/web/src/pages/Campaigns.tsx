import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '@/lib/utils'
import type { CampaignStatus } from '@aice/shared'

interface Campaign {
  id: string
  name: string
  bulan: string
  status: CampaignStatus
  totalCount: number
  sentCount: number
  replyCount: number
  createdAt: string
}

const STATUS_COLORS: Record<CampaignStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  RUNNING: 'bg-green-100 text-green-700',
  PAUSED: 'bg-yellow-100 text-yellow-700',
  COMPLETED: 'bg-blue-100 text-blue-700',
  CANCELLED: 'bg-red-100 text-red-600',
}

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    apiFetch<Campaign[]>('/api/campaigns')
      .then(setCampaigns)
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  async function handleCancel(id: string) {
    if (!confirm('Cancel this campaign?')) return
    await apiFetch(`/api/campaigns/${id}/cancel`, { method: 'POST' }).catch(console.error)
    load()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Campaigns</h2>
          <p className="text-muted-foreground">{campaigns.length} total</p>
        </div>
        <Link
          to="/campaigns/new"
          className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md"
        >
          New Campaign
        </Link>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground text-xs uppercase tracking-wider">
            <tr>
              {['Name', 'Month', 'Status', 'Progress', 'Reply Rate', 'Created', 'Actions'].map((h) => (
                <th key={h} className="px-4 py-2.5 text-left font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">Loading...</td></tr>
            )}
            {!loading && campaigns.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">No campaigns yet</td></tr>
            )}
            {!loading && campaigns.map((c) => {
              const progress = c.totalCount > 0 ? Math.round((c.sentCount / c.totalCount) * 100) : 0
              const replyRate = c.sentCount > 0 ? Math.round((c.replyCount / c.sentCount) * 100) : 0
              return (
                <tr key={c.id} className="hover:bg-accent/50 transition-colors">
                  <td className="px-4 py-2.5 font-medium">
                    <Link to={`/campaigns/${c.id}`} className="hover:underline">{c.name}</Link>
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
                  <td className="px-4 py-2.5 text-muted-foreground">{replyRate}%</td>
                  <td className="px-4 py-2.5 text-muted-foreground text-xs">
                    {new Date(c.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <Link to={`/campaigns/${c.id}`} className="text-xs text-primary hover:underline">View</Link>
                      {c.status === 'DRAFT' || c.status === 'RUNNING' || c.status === 'PAUSED' ? (
                        <button type="button" onClick={() => handleCancel(c.id)} className="text-xs text-destructive hover:underline">
                          Cancel
                        </button>
                      ) : null}
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
