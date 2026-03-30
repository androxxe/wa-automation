import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '@/lib/utils'

interface AgentCap {
  agentId: number
  name: string
  cap: number
  sent: number
  remaining: number
  status: string
}

interface Stats {
  totalContacts: number
  activeCampaigns: number
  sentToday: number
  replyRateToday: number
  dailyCapRemaining: number
  agents: AgentCap[]
}

interface BrowserAgent {
  agentId: number
  name: string
  status: string
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [campaigns, setCampaigns] = useState<unknown[]>([])
  const [agents, setAgents] = useState<BrowserAgent[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<Stats>('/api/stats')
      .then((d) => setStats(d))
      .catch((e) => setError(`Stats: ${e}`))

    apiFetch<{ agents: BrowserAgent[]; anyOnline: boolean }>('/api/browser/status')
      .then((d) => setAgents(d.agents))
      .catch((e) => setError(`Browser: ${e}`))

    apiFetch<unknown[]>('/api/campaigns')
      .then((d) => setCampaigns(d))
      .catch((e) => setError(`Campaigns: ${e}`))
  }, [])

  const anyOnline = agents.some((a) => a.status === 'ONLINE')

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
        <p className="text-muted-foreground">Campaign overview and live stats</p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Stats cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        {[
          { label: 'Total Contacts', value: stats?.totalContacts?.toLocaleString() ?? '—' },
          { label: 'Active Campaigns', value: stats?.activeCampaigns ?? '—' },
          { label: 'Sent Today', value: stats?.sentToday?.toLocaleString() ?? '—' },
          { label: 'Reply Rate', value: stats ? `${stats.replyRateToday}%` : '—' },
          { label: 'Cap Remaining', value: stats?.dailyCapRemaining?.toLocaleString() ?? '—' },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-lg border bg-card p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold">{String(value)}</p>
          </div>
        ))}
      </div>

      {/* Agent status overview */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <span
              className={`h-2.5 w-2.5 rounded-full ${anyOnline ? 'bg-green-500' : 'bg-red-500'}`}
            />
            <span className="text-sm font-medium">
              Agents: {anyOnline ? 'Online' : 'Offline'}
            </span>
          </div>
          <Link to="/agents" className="text-xs text-primary underline-offset-2 hover:underline">
            Manage agents
          </Link>
        </div>
        {agents.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {agents.map((a) => (
              <Link
                key={a.agentId}
                to="/agents"
                className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium ${
                  a.status === 'ONLINE'
                    ? 'bg-green-100 text-green-700'
                    : a.status === 'QR'
                      ? 'bg-yellow-100 text-yellow-700'
                      : a.status === 'STARTING'
                        ? 'bg-blue-100 text-blue-700'
                        : a.status === 'ERROR'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-gray-100 text-gray-600'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    a.status === 'ONLINE'
                      ? 'bg-green-500'
                      : a.status === 'QR'
                        ? 'bg-yellow-500'
                        : a.status === 'ERROR'
                          ? 'bg-red-500'
                          : 'bg-gray-400'
                  }`}
                />
                {a.name}: {a.status}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Per-agent daily cap table */}
      {stats && stats.agents.length > 0 && (
        <div className="rounded-lg border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b">
            <h3 className="font-semibold text-sm">Daily Cap per Agent</h3>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-muted text-xs uppercase text-muted-foreground">
              <tr>
                {['Agent', 'Status', 'Sent Today', 'Cap', 'Remaining'].map((h) => (
                  <th key={h} className="px-4 py-2 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {stats.agents.map((a) => (
                <tr key={a.agentId}>
                  <td className="px-4 py-2">{a.name}</td>
                  <td className="px-4 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      a.status === 'ONLINE'
                        ? 'bg-green-100 text-green-700'
                        : a.status === 'QR'
                          ? 'bg-yellow-100 text-yellow-700'
                          : 'bg-gray-100 text-gray-600'
                    }`}>
                      {a.status}
                    </span>
                  </td>
                  <td className="px-4 py-2">{a.sent}</td>
                  <td className="px-4 py-2">{a.cap}</td>
                  <td className="px-4 py-2 font-semibold">{a.remaining}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
            {(campaigns as Array<{ id: string; name: string; status: string; sentCount: number; totalCount: number; replyCount: number }>)
              .slice(0, 5)
              .map((c) => {
                const progress = c.totalCount > 0 ? Math.round((c.sentCount / c.totalCount) * 100) : 0
                const replyRate = c.sentCount > 0 ? Math.round((c.replyCount / c.sentCount) * 100 * 10) / 10 : 0
                return (
                  <Link
                    key={c.id}
                    to={`/campaigns/${c.id}`}
                    className="flex items-center gap-4 px-4 py-3 hover:bg-accent transition-colors"
                  >
                    <span className="flex-1 text-sm font-medium">{c.name}</span>
                    <div className="w-24">
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-muted-foreground">{c.sentCount}/{c.totalCount}</span>
                    </div>
                    <span className="text-xs text-muted-foreground w-16 text-right">
                      {replyRate}% reply
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
                )
              })}
          </div>
        )}
      </div>
    </div>
  )
}
