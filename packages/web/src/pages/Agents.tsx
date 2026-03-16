import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/utils'
import type { AppConfigData } from '@aice/shared'

interface Agent {
  id:             number
  name:           string
  profilePath:    string
  status:         string
  phoneNumber:    string
  breakEvery:     number | null
  breakMinMs:     number | null
  breakMaxMs:     number | null
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
  const queryClient = useQueryClient()
  const [showAdd, setShowAdd]   = useState(false)
  const [form, setForm]         = useState({ name: '', phoneNumber: '', departmentId: '', breakEvery: '', breakMinMs: '', breakMaxMs: '' })
  const [editing, setEditing]   = useState<Agent | null>(null)
  const [editForm, setEditForm] = useState({ name: '', phoneNumber: '', departmentId: '', breakEvery: '', breakMinMs: '', breakMaxMs: '' })

  const { data: config } = useQuery<AppConfigData>({
    queryKey: ['config'],
    queryFn:  () => apiFetch<AppConfigData>('/api/config'),
  })

  // Pre-fill break defaults from env when opening the Add form
  useEffect(() => {
    if (showAdd && config) {
      setForm((f) => ({
        ...f,
        breakEvery: f.breakEvery || String(config.defaultBreakEvery),
        breakMinMs: f.breakMinMs || String(config.defaultBreakMinSec),
        breakMaxMs: f.breakMaxMs || String(config.defaultBreakMaxSec),
      }))
    }
  }, [showAdd, config])

  // Poll every 5s — covers live screenshot + status updates
  const { data: agents = [], isLoading } = useQuery<Agent[]>({
    queryKey:       ['agents'],
    queryFn:        () => apiFetch<Agent[]>('/api/agents'),
    refetchInterval: 5000,
  })

  const { data: departments = [] } = useQuery<Department[]>({
    queryKey: ['departments'],
    queryFn:  () => apiFetch<Department[]>('/api/files/areas'),
  })

  const startMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/agents/${id}/start`, { method: 'POST' }),
    onSuccess:  () => setTimeout(() => queryClient.invalidateQueries({ queryKey: ['agents'] }), 1000),
  })

  const stopMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/agents/${id}/stop`, { method: 'POST' }),
    onSuccess:  () => setTimeout(() => queryClient.invalidateQueries({ queryKey: ['agents'] }), 1000),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/agents/${id}`, { method: 'DELETE' }),
    onSuccess:  () => queryClient.invalidateQueries({ queryKey: ['agents'] }),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: { name?: string; phoneNumber?: string; departmentId?: string | null; breakEvery?: number | null; breakMinMs?: number | null; breakMaxMs?: number | null } }) =>
      apiFetch(`/api/agents/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      setEditing(null)
    },
  })

  const createMutation = useMutation({
    mutationFn: (data: { name: string; phoneNumber: string; departmentId?: string; breakEvery?: number; breakMinMs?: number; breakMaxMs?: number }) =>
      apiFetch('/api/agents', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      setShowAdd(false)
      // Reset to empty — useEffect will re-fill break defaults on next open
      setForm({ name: '', phoneNumber: '', departmentId: '', breakEvery: '', breakMinMs: '', breakMaxMs: '' })
    },
  })

  function handleEdit(agent: Agent) {
    setEditing(agent)
    setEditForm({
      name:         agent.name,
      phoneNumber:  agent.phoneNumber,
      departmentId: agent.departmentId ?? '',
      // Use agent's override if set, otherwise fill with env default so user sees actual value
      breakEvery:   String(agent.breakEvery  ?? config?.defaultBreakEvery  ?? 30),
      breakMinMs:   String(Math.round((agent.breakMinMs ?? (config ? config.defaultBreakMinSec * 1000 : 180000)) / 1000)),
      breakMaxMs:   String(Math.round((agent.breakMaxMs ?? (config ? config.defaultBreakMaxSec * 1000 : 480000)) / 1000)),
    })
  }

  function handleSaveEdit() {
    if (!editing || !editForm.name || !editForm.phoneNumber) return
    updateMutation.mutate({
      id: editing.id,
      data: {
        name:         editForm.name,
        phoneNumber:  editForm.phoneNumber,
        departmentId: editForm.departmentId || null,
        breakEvery:   editForm.breakEvery   ? parseInt(editForm.breakEvery)              : null,
        breakMinMs:   editForm.breakMinMs   ? parseInt(editForm.breakMinMs)   * 1000     : null,
        breakMaxMs:   editForm.breakMaxMs   ? parseInt(editForm.breakMaxMs)   * 1000     : null,
      },
    })
  }

  function handleAdd() {
    if (!form.name || !form.phoneNumber) return
    createMutation.mutate({
      name:        form.name,
      phoneNumber: form.phoneNumber,
      ...(form.departmentId && { departmentId: form.departmentId }),
      ...(form.breakEvery   && { breakEvery:   parseInt(form.breakEvery) }),
      ...(form.breakMinMs   && { breakMinMs:   parseInt(form.breakMinMs) * 1000 }),
      ...(form.breakMaxMs   && { breakMaxMs:   parseInt(form.breakMaxMs) * 1000 }),
    })
  }

  // ─── Edit modal ─────────────────────────────────────────────────────────────
  const EditModal = editing && (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/40" onClick={() => setEditing(null)} />
      <div className="relative bg-background rounded-lg shadow-lg border w-full max-w-lg mx-4 p-6 space-y-4">
        <h3 className="font-semibold">Edit Agent — {editing.name}</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label htmlFor="edit-name" className="text-sm font-medium">Name</label>
            <input id="edit-name" value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} className="w-full text-sm rounded-md border px-3 py-1.5 bg-background" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="edit-phone" className="text-sm font-medium">Phone number</label>
            <input id="edit-phone" value={editForm.phoneNumber} onChange={(e) => setEditForm((f) => ({ ...f, phoneNumber: e.target.value }))} placeholder="+628xxxxxxxxx" className="w-full text-sm rounded-md border px-3 py-1.5 bg-background" />
          </div>
          <div className="space-y-1.5 col-span-2">
            <label htmlFor="edit-dept" className="text-sm font-medium">Department</label>
            <select id="edit-dept" value={editForm.departmentId} onChange={(e) => setEditForm((f) => ({ ...f, departmentId: e.target.value }))} className="w-full text-sm rounded-md border px-3 py-1.5 bg-background">
              <option value="">— Shared pool —</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Break settings (blank = use .env default)</p>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <label htmlFor="edit-break-every" className="text-xs text-muted-foreground">Break every (msgs)</label>
              <input id="edit-break-every" type="number" min={1} value={editForm.breakEvery} onChange={(e) => setEditForm((f) => ({ ...f, breakEvery: e.target.value }))} placeholder={`${editing.breakEvery ?? 30}`} className="w-full text-sm rounded-md border px-3 py-1.5 bg-background" />
            </div>
            <div className="space-y-1">
              <label htmlFor="edit-break-min" className="text-xs text-muted-foreground">Min break (sec)</label>
              <input id="edit-break-min" type="number" min={1} value={editForm.breakMinMs} onChange={(e) => setEditForm((f) => ({ ...f, breakMinMs: e.target.value }))} placeholder={`${Math.round((editing.breakMinMs ?? 180000) / 1000)}`} className="w-full text-sm rounded-md border px-3 py-1.5 bg-background" />
            </div>
            <div className="space-y-1">
              <label htmlFor="edit-break-max" className="text-xs text-muted-foreground">Max break (sec)</label>
              <input id="edit-break-max" type="number" min={1} value={editForm.breakMaxMs} onChange={(e) => setEditForm((f) => ({ ...f, breakMaxMs: e.target.value }))} placeholder={`${Math.round((editing.breakMaxMs ?? 480000) / 1000)}`} className="w-full text-sm rounded-md border px-3 py-1.5 bg-background" />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={() => setEditing(null)} className="border text-sm px-4 py-2 rounded-md">Cancel</button>
          <button
            type="button"
            onClick={handleSaveEdit}
            disabled={updateMutation.isPending || !editForm.name || !editForm.phoneNumber}
            className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md disabled:opacity-50"
          >
            {updateMutation.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="space-y-6">
      {EditModal}
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
              <label htmlFor="agent-phone" className="text-sm font-medium">Phone number <span className="text-destructive">*</span></label>
              <input
                id="agent-phone"
                value={form.phoneNumber}
                onChange={(e) => setForm((f) => ({ ...f, phoneNumber: e.target.value }))}
                placeholder="+628xxxxxxxxx"
                className="w-full text-sm rounded-md border px-3 py-1.5 bg-background"
              />
              <p className="text-xs text-muted-foreground">WhatsApp number of this agent's account</p>
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
          {/* Break settings */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Break settings (leave blank to use .env defaults)</p>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <label htmlFor="add-break-every" className="text-xs text-muted-foreground">Break every (messages)</label>
                <input id="add-break-every" type="number" min={1} value={form.breakEvery} onChange={(e) => setForm((f) => ({ ...f, breakEvery: e.target.value }))} className="w-full text-sm rounded-md border px-3 py-1.5 bg-background" />
              </div>
              <div className="space-y-1">
                <label htmlFor="add-break-min" className="text-xs text-muted-foreground">Min break (seconds)</label>
                <input id="add-break-min" type="number" min={1} value={form.breakMinMs} onChange={(e) => setForm((f) => ({ ...f, breakMinMs: e.target.value }))} className="w-full text-sm rounded-md border px-3 py-1.5 bg-background" />
              </div>
              <div className="space-y-1">
                <label htmlFor="add-break-max" className="text-xs text-muted-foreground">Max break (seconds)</label>
                <input id="add-break-max" type="number" min={1} value={form.breakMaxMs} onChange={(e) => setForm((f) => ({ ...f, breakMaxMs: e.target.value }))} className="w-full text-sm rounded-md border px-3 py-1.5 bg-background" />
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleAdd}
              disabled={createMutation.isPending || !form.name || !form.phoneNumber}
              className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md disabled:opacity-50"
            >
              {createMutation.isPending ? 'Creating…' : 'Create Agent'}
            </button>
            <button type="button" onClick={() => setShowAdd(false)} className="border text-sm px-4 py-2 rounded-md">
              Cancel
            </button>
          </div>
        </div>
      )}

      {isLoading && <div className="text-center py-12 text-muted-foreground">Loading agents…</div>}
      {!isLoading && agents.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">No agents configured yet.</div>
      )}

      <div className="grid gap-4">
        {agents.map((agent) => (
          <div key={agent.id} className="rounded-lg border bg-card p-5">
            <div className="flex items-start gap-4">
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

              <div className="flex-1 min-w-0 space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${STATUS_COLORS[agent.status] ?? 'bg-gray-400'}`} />
                  <span className="font-semibold">{agent.name}</span>
                  <span className="text-xs text-muted-foreground">#{agent.id}</span>
                  {agent.phoneNumber && (
                    <span className="text-xs font-mono bg-muted px-2 py-0.5 rounded-full">{agent.phoneNumber}</span>
                  )}
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
                  <div>
                    Break: every{' '}
                    <span className="text-foreground font-medium">{agent.breakEvery ?? '30'}</span> msgs,{' '}
                    <span className="text-foreground font-medium">{Math.round((agent.breakMinMs ?? 180000) / 1000)}</span>–
                    <span className="text-foreground font-medium">{Math.round((agent.breakMaxMs ?? 480000) / 1000)}</span>s
                    {(agent.breakEvery == null && agent.breakMinMs == null) && <span className="ml-1 text-muted-foreground">(from .env)</span>}
                  </div>
                </div>
                {agent.status === 'QR' && (
                  <div className="text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-3 py-2">
                    QR code visible — check the preview above and scan with your phone.
                  </div>
                )}
              </div>

              <div className="shrink-0 flex gap-2">
                <button
                  type="button"
                  onClick={() => handleEdit(agent)}
                  className="border text-sm px-3 py-1.5 rounded-md hover:bg-accent"
                >
                  Edit
                </button>
                {agent.status === 'OFFLINE' ? (
                  <button
                    type="button"
                    onClick={() => startMutation.mutate(agent.id)}
                    disabled={startMutation.isPending}
                    className="bg-primary text-primary-foreground text-sm px-3 py-1.5 rounded-md disabled:opacity-50"
                  >
                    Start
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => stopMutation.mutate(agent.id)}
                    disabled={agent.status === 'STARTING' || stopMutation.isPending}
                    className="border text-sm px-3 py-1.5 rounded-md disabled:opacity-50"
                  >
                    Stop
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (!confirm('Delete this agent?')) return
                    deleteMutation.mutate(agent.id)
                  }}
                  disabled={agent.status !== 'OFFLINE' || deleteMutation.isPending}
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
