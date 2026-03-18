import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

type WarmSessionStatus  = 'IDLE' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED'
type WarmExchangeStatus = 'PENDING' | 'SENT' | 'REPLIED' | 'FAILED'

interface WarmAgent {
  agentId:     number
  agentName:   string
  phoneNumber: string
}

interface WarmSession {
  id:             string
  name:           string
  status:         WarmSessionStatus
  totalExchanges: number
  doneExchanges:  number
  partialFailure: boolean
  createdAt:      string
  startedAt:      string | null
  completedAt:    string | null
  agents:         WarmAgent[]
}

interface WarmExchange {
  id:               string
  warmSessionId:    string
  senderAgentId:    number
  recipientAgentId: number
  message:          string
  replyMessage:     string
  status:           WarmExchangeStatus
  sentAt:           string | null
  repliedAt:        string | null
  failReason:       string | null
  createdAt:        string
}

interface WarmSessionDetail extends WarmSession {
  exchanges: WarmExchange[]
}

interface PickerAgent {
  id:          number
  name:        string
  phoneNumber: string
  warmMode:    boolean
  status:      string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<WarmSessionStatus, string> = {
  IDLE:      'bg-gray-100 text-gray-700',
  RUNNING:   'bg-blue-100 text-blue-700 animate-pulse',
  PAUSED:    'bg-yellow-100 text-yellow-700',
  COMPLETED: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-red-100 text-red-700',
}

const EXCHANGE_BADGE: Record<WarmExchangeStatus, string> = {
  PENDING: 'bg-gray-100 text-gray-600',
  SENT:    'bg-blue-100 text-blue-700',
  REPLIED: 'bg-green-100 text-green-700',
  FAILED:  'bg-red-100 text-red-700',
}

function fmt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground shrink-0">{done}/{total} ({pct}%)</span>
    </div>
  )
}

// ─── Session Detail (expandable) ──────────────────────────────────────────────

function SessionDetail({ sessionId, agentMap }: { sessionId: string; agentMap: Map<number, string> }) {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery<WarmSessionDetail>({
    queryKey:        ['warm-session', sessionId],
    queryFn:         () => apiFetch<WarmSessionDetail>(`/api/warmer/sessions/${sessionId}`),
    refetchInterval: 10000,
  })

  // SSE for live updates
  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'
    const es = new EventSource(`${apiUrl}/api/warmer/sessions/${sessionId}/events`)
    es.onmessage = () => {
      queryClient.invalidateQueries({ queryKey: ['warm-session', sessionId] })
      queryClient.invalidateQueries({ queryKey: ['warm-sessions'] })
    }
    es.onerror = () => es.close()
    return () => es.close()
  }, [sessionId, queryClient])

  if (isLoading) return <div className="py-4 text-center text-sm text-muted-foreground">Loading exchanges…</div>
  if (!data) return null

  return (
    <div className="mt-3 border rounded-md overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/50 text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">#</th>
            <th className="px-3 py-2 text-left font-medium">Sender</th>
            <th className="px-3 py-2 text-left font-medium">Recipient</th>
            <th className="px-3 py-2 text-left font-medium">Message</th>
            <th className="px-3 py-2 text-left font-medium">Reply</th>
            <th className="px-3 py-2 text-left font-medium">Status</th>
            <th className="px-3 py-2 text-left font-medium">Sent</th>
            <th className="px-3 py-2 text-left font-medium">Replied</th>
          </tr>
        </thead>
        <tbody>
          {data.exchanges.map((ex, i) => (
            <tr key={ex.id} className="border-t hover:bg-muted/30">
              <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
              <td className="px-3 py-2">{agentMap.get(ex.senderAgentId) ?? `#${ex.senderAgentId}`}</td>
              <td className="px-3 py-2">{agentMap.get(ex.recipientAgentId) ?? `#${ex.recipientAgentId}`}</td>
              <td className="px-3 py-2 max-w-[180px] truncate" title={ex.message}>{ex.message}</td>
              <td className="px-3 py-2 max-w-[180px] truncate" title={ex.replyMessage}>{ex.replyMessage}</td>
              <td className="px-3 py-2">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${EXCHANGE_BADGE[ex.status]}`}>
                  {ex.status}
                </span>
                {ex.failReason && (
                  <span className="ml-1 text-red-500" title={ex.failReason}>⚠</span>
                )}
              </td>
              <td className="px-3 py-2 text-muted-foreground">{fmt(ex.sentAt)}</td>
              <td className="px-3 py-2 text-muted-foreground">{fmt(ex.repliedAt)}</td>
            </tr>
          ))}
          {data.exchanges.length === 0 && (
            <tr>
              <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                No exchanges yet — start the session to begin
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

// ─── Create Session Modal ──────────────────────────────────────────────────────

function CreateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const [name, setName]             = useState('')
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [totalExchanges, setTotal]  = useState(30)
  const [error, setError]           = useState('')

  const { data: agents = [] } = useQuery<PickerAgent[]>({
    queryKey: ['agents'],
    queryFn:  () => apiFetch<PickerAgent[]>('/api/agents'),
  })

  const warmAgents = agents.filter((a) => a.warmMode && a.status === 'ONLINE')

  const createMutation = useMutation({
    mutationFn: (data: { name: string; agentIds: number[]; totalExchanges: number }) =>
      apiFetch('/api/warmer/sessions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(data),
      }),
    onSuccess: () => onCreated(),
    onError:   (err: Error) => setError(err.message),
  })

  function toggleAgent(id: number) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < 4 ? [...prev, id] : prev,
    )
  }

  const estimatedHours = ((totalExchanges * 25) / 60).toFixed(1)
  const valid = name.trim().length > 0 && selectedIds.length >= 2 && totalExchanges >= 10 && totalExchanges <= 500

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-background rounded-lg shadow-lg border w-full max-w-md mx-4 p-6 space-y-4">
        <h3 className="font-semibold">New Warm Session</h3>

        <div className="space-y-1.5">
          <label htmlFor="session-name" className="text-sm font-medium">Session Name</label>
          <input
            id="session-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Warm batch 1"
            className="w-full text-sm rounded-md border px-3 py-1.5 bg-background"
          />
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-medium">
            Agents <span className="text-muted-foreground font-normal">(min 2, max 4 — warm mode only)</span>
          </p>
          {warmAgents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agents with warm mode enabled are online.</p>
          ) : (
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {warmAgents.map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(a.id)}
                    onChange={() => toggleAgent(a.id)}
                    disabled={!selectedIds.includes(a.id) && selectedIds.length >= 4}
                    className="rounded"
                  />
                  <span>{a.name}</span>
                  <span className="text-xs text-muted-foreground font-mono">{a.phoneNumber}</span>
                </label>
              ))}
            </div>
          )}
          {selectedIds.length > 0 && (
            <p className="text-xs text-muted-foreground">{selectedIds.length} selected</p>
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="total-exchanges" className="text-sm font-medium">Total Exchanges</label>
          <input
            id="total-exchanges"
            type="number"
            min={10}
            max={500}
            value={totalExchanges}
            onChange={(e) => setTotal(parseInt(e.target.value) || 30)}
            className="w-full text-sm rounded-md border px-3 py-1.5 bg-background"
          />
          <p className="text-xs text-muted-foreground">
            Each exchange = 1 message + 1 reply (~25 min between exchanges) · Estimated: ~{estimatedHours} hours
          </p>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="border text-sm px-4 py-2 rounded-md">
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || createMutation.isPending}
            onClick={() => createMutation.mutate({ name: name.trim(), agentIds: selectedIds, totalExchanges })}
            className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md disabled:opacity-50"
          >
            {createMutation.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Warmer() {
  const queryClient    = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [expanded, setExpanded]     = useState<string | null>(null)

  const { data: sessions = [], isLoading } = useQuery<WarmSession[]>({
    queryKey:        ['warm-sessions'],
    queryFn:         () => apiFetch<WarmSession[]>('/api/warmer/sessions'),
    refetchInterval: 10000,
  })

  // Build a global agent name map from all sessions for the exchange table
  const agentMap = new Map<number, string>()
  for (const s of sessions) {
    for (const a of s.agents) agentMap.set(a.agentId, a.agentName)
  }

  function mutate(url: string, method = 'POST') {
    return apiFetch(url, { method }).then(() => {
      queryClient.invalidateQueries({ queryKey: ['warm-sessions'] })
    })
  }

  const startMutation  = useMutation({ mutationFn: (id: string) => mutate(`/api/warmer/sessions/${id}/start`) })
  const pauseMutation  = useMutation({ mutationFn: (id: string) => mutate(`/api/warmer/sessions/${id}/pause`) })
  const resumeMutation = useMutation({ mutationFn: (id: string) => mutate(`/api/warmer/sessions/${id}/resume`) })
  const cancelMutation = useMutation({ mutationFn: (id: string) => mutate(`/api/warmer/sessions/${id}/cancel`) })
  const deleteMutation = useMutation({
    mutationFn: (id: string) => mutate(`/api/warmer/sessions/${id}`, 'DELETE'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['warm-sessions'] }),
  })

  return (
    <div className="space-y-6">
      {showCreate && (
        <CreateModal
          onClose={()  => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false)
            queryClient.invalidateQueries({ queryKey: ['warm-sessions'] })
          }}
        />
      )}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Warmer</h2>
          <p className="text-muted-foreground">Simulate organic WhatsApp activity to warm up new numbers</p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md"
        >
          New Session
        </button>
      </div>

      {isLoading && (
        <div className="text-center py-12 text-muted-foreground">Loading sessions…</div>
      )}
      {!isLoading && sessions.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No warm sessions yet. Create one to get started.
        </div>
      )}

      <div className="space-y-3">
        {sessions.map((session) => (
          <div key={session.id} className="rounded-lg border bg-card p-4">
            {/* Session header row */}
            <div className="flex items-center gap-4 flex-wrap">
              {/* Name + status */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold truncate">{session.name}</span>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[session.status]}`}>
                    {session.status}
                  </span>
                  {session.partialFailure && session.status === 'COMPLETED' && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-700">
                      Partial failure
                    </span>
                  )}
                </div>
                {/* Agents avatars */}
                <div className="flex gap-1 mt-1 flex-wrap">
                  {session.agents.map((a) => (
                    <span
                      key={a.agentId}
                      className="inline-flex items-center bg-muted text-xs px-1.5 py-0.5 rounded-full"
                      title={a.phoneNumber}
                    >
                      {a.agentName}
                    </span>
                  ))}
                </div>
              </div>

              {/* Progress bar */}
              <div className="w-48 shrink-0">
                <Progress done={session.doneExchanges} total={session.totalExchanges} />
              </div>

              {/* Action buttons */}
              <div className="flex gap-1.5 shrink-0 flex-wrap">
                {session.status === 'IDLE' && (
                  <button
                    type="button"
                    onClick={() => startMutation.mutate(session.id)}
                    disabled={startMutation.isPending}
                    className="bg-primary text-primary-foreground text-xs px-3 py-1.5 rounded-md disabled:opacity-50"
                  >
                    Start
                  </button>
                )}
                {session.status === 'RUNNING' && (
                  <button
                    type="button"
                    onClick={() => pauseMutation.mutate(session.id)}
                    disabled={pauseMutation.isPending}
                    className="border text-xs px-3 py-1.5 rounded-md disabled:opacity-50"
                  >
                    Pause
                  </button>
                )}
                {session.status === 'PAUSED' && (
                  <button
                    type="button"
                    onClick={() => resumeMutation.mutate(session.id)}
                    disabled={resumeMutation.isPending}
                    className="bg-primary text-primary-foreground text-xs px-3 py-1.5 rounded-md disabled:opacity-50"
                  >
                    Resume
                  </button>
                )}
                {['IDLE', 'RUNNING', 'PAUSED'].includes(session.status) && (
                  <button
                    type="button"
                    onClick={() => {
                      if (!confirm('Cancel this session?')) return
                      cancelMutation.mutate(session.id)
                    }}
                    disabled={cancelMutation.isPending}
                    className="border border-red-200 text-red-600 text-xs px-3 py-1.5 rounded-md disabled:opacity-50"
                  >
                    Cancel
                  </button>
                )}
                {['IDLE', 'COMPLETED'].includes(session.status) && (
                  <button
                    type="button"
                    onClick={() => {
                      if (!confirm('Delete this session?')) return
                      deleteMutation.mutate(session.id)
                    }}
                    disabled={deleteMutation.isPending}
                    className="border text-xs px-3 py-1.5 rounded-md text-muted-foreground disabled:opacity-50"
                  >
                    Delete
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setExpanded((prev) => (prev === session.id ? null : session.id))}
                  className="border text-xs px-3 py-1.5 rounded-md text-muted-foreground"
                >
                  {expanded === session.id ? 'Hide log' : 'View log'}
                </button>
              </div>
            </div>

            {/* Expandable exchange log */}
            {expanded === session.id && (
              <SessionDetail sessionId={session.id} agentMap={agentMap} />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
