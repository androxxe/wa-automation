import { useEffect, useState, useCallback } from 'react'
import { apiFetch } from '@/lib/utils'

interface Agent {
  id:             number
  name:           string
  profilePath:    string
  status:         string
  departmentId:   string | null
  departmentName: string | null
  activeJobCount: number
  screenshot:     string | null
}

interface Department {
  id:   string
  name: string
}

const STATUS_COLORS: Record<string, string> = {
  ONLINE:   'bg-green-500',
  QR:       'bg-yellow-500 animate-pulse',
  STARTING: 'bg-blue-500 animate-pulse',
  ERROR:    'bg-red-500',
  OFFLINE:  'bg-gray-400',
}

export default function Agents() {
  const [agents, setAgents]           = useState<Agent[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [loading, setLoading]         = useState(true)
  const [showAdd, setShowAdd]         = useState(false)
  const [form, setForm]               = useState({ name: '', departmentId: '' })
  const [saving, setSaving]           = useState(false)

  const loadAgents = useCallback(() => {
    apiFetch<Agent[]>('/api/agents')
      .then((d) => setAgents(d))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadAgents()
    apiFetch<Department[]>('/api/files/areas')
      .then((d) => setDepartments(d))
      .catch(console.error)
    const interval = setInterval(loadAgents, 5000)
    return () => clearInterval(interval)
  }, [loadAgents])

  async function handleStart(id: number) {
    await apiFetch(`/api/agents/${id}/start`, { method: 'POST' }).catch(console.error)
    setTimeout(loadAgents, 1000)
  }

  async function handleStop(id: number) {
    await apiFetch(`/api/agents/${id}/stop`, { method: 'POST' }).catch(console.error)
    setTimeout(loadAgents, 1000)
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this agent?')) return
    await apiFetch(`/api/agents/${id}`, { method: 'DELETE' }).catch(console.error)
    loadAgents()
  }

  async function handleAddAgent() {
    if (!form.name) return
    setSaving(true)
    try {
      await apiFetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          ...(form.departmentId && { departmentId: form.departmentId }),
        }),
      })
      setShowAdd(false)
      setForm({ name: '', departmentId: '' })
      loadAgents()
    } catch (err) {
      alert(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Agents</h2>
          <p className="text-muted-foreground">Manage WhatsApp browser agents</p>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md"
        >
          Add Agent
        </button>
      </div>

      {/* Add Agent form */}
      {showAdd && (
        <div className="rounded-lg border bg-card p-5 space-y-4">
          <h3 className="font-semibold">New Agent</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="agent-name" className="text-sm font-medium">Name</label>
              <input
                id="agent-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Agent 1"
                className="w-full text-sm rounded-md border px-3 py-1.5 bg-background"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="agent-dept" className="text-sm font-medium">Department (optional)</label>
              <select
                id="agent-dept"
                value={form.departmentId}
                onChange={(e) => setForm((f) => ({ ...f, departmentId: e.target.value }))}
                className="w-full text-sm rounded-md border px-3 py-1.5 bg-background"
              >
                <option value="">— Shared pool —</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleAddAgent}
              disabled={saving || !form.name}
              className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md disabled:opacity-50"
            >
              {saving ? 'Creating…' : 'Create Agent'}
            </button>
            <button
              type="button"
              onClick={() => setShowAdd(false)}
              className="border text-sm px-4 py-2 rounded-md"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Agent list */}
      {loading && (
        <div className="text-center py-12 text-muted-foreground">Loading agents…</div>
      )}
      {!loading && agents.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">No agents configured yet.</div>
      )}

      <div className="grid gap-4">
        {agents.map((agent) => (
          <div key={agent.id} className="rounded-lg border bg-card p-5">
            <div className="flex items-start gap-4">
              {/* Screenshot thumbnail */}
              <div className="shrink-0 w-40 h-28 rounded-md overflow-hidden border bg-muted flex items-center justify-center">
                {agent.screenshot ? (
                  <img
                    src={`data:image/jpeg;base64,${agent.screenshot}`}
                    alt={`${agent.name} preview`}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">No preview</span>
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0 space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${STATUS_COLORS[agent.status] ?? 'bg-gray-400'}`} />
                  <span className="font-semibold">{agent.name}</span>
                  <span className="text-xs text-muted-foreground capitalize">{agent.status.toLowerCase()}</span>
                  {agent.activeJobCount > 0 && (
                    <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">
                      {agent.activeJobCount} active
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <div>Profile: <span className="font-mono">{agent.profilePath}</span></div>
                  <div>Department: {agent.departmentName ?? 'Shared pool'}</div>
                </div>
                {agent.status === 'QR' && (
                  <div className="text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-3 py-2">
                    QR code visible — check the preview above and scan with your phone.
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="shrink-0 flex gap-2">
                {agent.status === 'OFFLINE' ? (
                  <button
                    type="button"
                    onClick={() => handleStart(agent.id)}
                    className="bg-primary text-primary-foreground text-sm px-3 py-1.5 rounded-md"
                  >
                    Start
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleStop(agent.id)}
                    disabled={agent.status === 'STARTING'}
                    className="border text-sm px-3 py-1.5 rounded-md disabled:opacity-50"
                  >
                    Stop
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleDelete(agent.id)}
                  disabled={agent.status !== 'OFFLINE'}
                  className="text-red-600 border border-red-200 text-sm px-3 py-1.5 rounded-md disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
