import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '@/lib/utils'

interface Stats {
  totalContacts: number
  activeCampaigns: number
  sentToday: number
  replyRateToday: number
  dailyCapRemaining: number
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [campaigns, setCampaigns] = useState<unknown[]>([])
  const [browserStatus, setBrowserStatus] = useState<string>('disconnected')

  useEffect(() => {
    apiFetch<{ status: string }>('/api/browser/status')
      .then((d) => setBrowserStatus(d.status))
      .catch(() => {})
    apiFetch<unknown[]>('/api/campaigns')
      .then((d) => setCampaigns(d))
      .catch(() => {})
  }, [])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
        <p className="text-muted-foreground">Campaign overview and live stats</p>
      </div>

      {/* Stats cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        {[
          { label: 'Total Contacts', value: stats?.totalContacts ?? '—' },
          { label: 'Active Campaigns', value: stats?.activeCampaigns ?? '—' },
          { label: 'Sent Today', value: stats?.sentToday ?? '—' },
          { label: 'Reply Rate', value: stats ? `${stats.replyRateToday}%` : '—' },
          { label: 'Cap Remaining', value: stats?.dailyCapRemaining ?? '—' },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-lg border bg-card p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold">{String(value)}</p>
          </div>
        ))}
      </div>

      {/* Browser status */}
      <div className="rounded-lg border bg-card p-4 flex items-center gap-3">
        <span
          className={`h-2.5 w-2.5 rounded-full ${
            browserStatus === 'connected'
              ? 'bg-green-500'
              : browserStatus === 'qr'
                ? 'bg-yellow-500'
                : 'bg-red-500'
          }`}
        />
        <span className="text-sm font-medium capitalize">Browser: {browserStatus}</span>
        <Link to="/settings" className="ml-auto text-xs text-primary underline-offset-2 hover:underline">
          Manage
        </Link>
      </div>

      {/* Recent campaigns */}
      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-semibold text-sm">Recent Campaigns</h3>
          <Link to="/campaigns" className="text-xs text-primary underline-offset-2 hover:underline">
            View all
          </Link>
        </div>
        {campaigns.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground text-center">No campaigns yet</p>
        ) : (
          <div className="divide-y">
            {(campaigns as Array<{ id: string; name: string; status: string; sentCount: number; totalCount: number }>)
              .slice(0, 5)
              .map((c) => (
                <Link
                  key={c.id}
                  to={`/campaigns/${c.id}`}
                  className="flex items-center gap-4 px-4 py-3 hover:bg-accent transition-colors"
                >
                  <span className="flex-1 text-sm font-medium">{c.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {c.sentCount}/{c.totalCount}
                  </span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      c.status === 'RUNNING'
                        ? 'bg-green-100 text-green-700'
                        : c.status === 'PAUSED'
                          ? 'bg-yellow-100 text-yellow-700'
                          : c.status === 'DRAFT'
                            ? 'bg-gray-100 text-gray-600'
                            : 'bg-blue-100 text-blue-700'
                    }`}
                  >
                    {c.status}
                  </span>
                </Link>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}
