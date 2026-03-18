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
  dailySendCap:   number | null
  breakEvery:     number | null
  breakMinMs:     number | null
  breakMaxMs:     number | null
  typeDelayMinMs: number | null
  typeDelayMaxMs: number | null
  departmentId:   string | null
  departmentName: string | null
  activeJobCount: number
  sentToday:      number
  screenshot:     string | null
  warmMode:       boolean
  isWarmed:       boolean
  warmedAt:       string | null
  validationOnly: boolean
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
  const [form, setForm]         = useState({ name: '', phoneNumber: '', departmentId: '', dailySendCap: '', breakEvery: '', breakMinMs: '', breakMaxMs: '', typeDelayMin: '', typeDelayMax: '' })
  const [editing, setEditing]   = useState<Agent | null>(null)
  const [editForm, setEditForm] = useState({ name: '', phoneNumber: '', departmentId: '', dailySendCap: '', breakEvery: '', breakMinMs: '', breakMaxMs: '', typeDelayMin: '', typeDelayMax: '', warmMode: false, validationOnly: false })

  const { data: config } = useQuery<AppConfigData>({
    queryKey: ['config'],
    queryFn:  () => apiFetch<AppConfigData>('/api/config'),
  })

  // Pre-fill defaults from env when opening the Add form
  useEffect(() => {
    if (showAdd && config) {
      setForm((f) => ({
        ...f,
        dailySendCap: f.dailySendCap || String(config.defaultDailySendCap),
        breakEvery:   f.breakEvery   || String(config.defaultBreakEvery),
        breakMinMs:   f.breakMinMs   || String(config.defaultBreakMinSec),
        breakMaxMs:   f.breakMaxMs   || String(config.defaultBreakMaxSec),
        typeDelayMin: f.typeDelayMin || String(config.defaultTypeDelayMin),
        typeDelayMax: f.typeDelayMax || String(config.defaultTypeDelayMax),
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
    mutationFn: ({ id, data }: { id: number; data: { name?: string; phoneNumber?: string; departmentId?: string | null; dailySendCap?: number | null; breakEvery?: number | null; breakMinMs?: number | null; breakMaxMs?: number | null; typeDelayMinMs?: number | null; typeDelayMaxMs?: number | null; warmMode?: boolean; validationOnly?: boolean } }) =>
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
    mutationFn: (data: { name: string; phoneNumber: string; departmentId?: string; dailySendCap?: number; breakEvery?: number; breakMinMs?: number; breakMaxMs?: number; typeDelayMinMs?: number; typeDelayMaxMs?: number }) =>
      apiFetch('/api/agents', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      setShowAdd(false)
      // Reset to empty — useEffect will re-fill break defaults on next open
      setForm({ name: '', phoneNumber: '', departmentId: '', dailySendCap: '', breakEvery: '', breakMinMs: '', breakMaxMs: '', typeDelayMin: '', typeDelayMax: '' })
    },
  })

  function handleEdit(agent: Agent) {
    setEditing(agent)
    setEditForm({
      name:           agent.name,
      phoneNumber:    agent.phoneNumber,
      departmentId:   agent.departmentId ?? '',
      dailySendCap:   String(agent.dailySendCap   ?? config?.defaultDailySendCap ?? 150),
      breakEvery:     String(agent.breakEvery      ?? config?.defaultBreakEvery   ?? 30),
      breakMinMs:     String(Math.round((agent.breakMinMs ?? (config ? config.defaultBreakMinSec * 1000 : 180000)) / 1000)),
      breakMaxMs:     String(Math.round((agent.breakMaxMs ?? (config ? config.defaultBreakMaxSec * 1000 : 480000)) / 1000)),
      typeDelayMin:   String(agent.typeDelayMinMs  ?? config?.defaultTypeDelayMin ?? 80),
      typeDelayMax:   String(agent.typeDelayMaxMs  ?? config?.defaultTypeDelayMax ?? 180),
      warmMode:       agent.warmMode,
      validationOnly: agent.validationOnly,
    })
  }

  function handleSaveEdit() {
    if (!editing || !editForm.name || !editForm.phoneNumber) return
    updateMutation.mutate({
      id: editing.id,
      data: {
        name:           editForm.name,
        phoneNumber:    editForm.phoneNumber,
        departmentId:   editForm.departmentId || null,
        dailySendCap:   editForm.dailySendCap  ? parseInt(editForm.dailySendCap)          : null,
        breakEvery:     editForm.breakEvery    ? parseInt(editForm.breakEvery)             : null,
        breakMinMs:     editForm.breakMinMs    ? parseInt(editForm.breakMinMs) * 1000      : null,
        breakMaxMs:     editForm.breakMaxMs    ? parseInt(editForm.breakMaxMs) * 1000      : null,
        typeDelayMinMs: editForm.typeDelayMin  ? parseInt(editForm.typeDelayMin)            : null,
        typeDelayMaxMs: editForm.typeDelayMax  ? parseInt(editForm.typeDelayMax)            : null,
        warmMode:       editForm.warmMode,
        validationOnly: editForm.validationOnly,
      },
    })
  }

  function handleAdd() {
    if (!form.name || !form.phoneNumber) return
    createMutation.mutate({
      name:        form.name,
      phoneNumber: form.phoneNumber,
      ...(form.departmentId && { departmentId:   form.departmentId }),
      ...(form.dailySendCap && { dailySendCap:   parseInt(form.dailySendCap) }),
      ...(form.breakEvery   && { breakEvery:     parseInt(form.breakEvery) }),
      ...(form.breakMinMs   && { breakMinMs:     parseInt(form.breakMinMs) * 1000 }),
      ...(form.breakMaxMs   && { breakMaxMs:     parseInt(form.breakMaxMs) * 1000 }),
      ...(form.typeDelayMin && { typeDelayMinMs: parseInt(form.typeDelayMin) }),
      ...(form.typeDelayMax && { typeDelayMaxMs: parseInt(form.typeDelayMax) }),
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
        <div className="space-y-1">
          <label htmlFor="edit-daily-cap" className="text-xs font-medium text-muted-foreground">Daily send cap (messages/day)</label>
          <input id="edit-daily-cap" type="number" min={1} value={editForm.dailySendCap} onChange={(e) => setEditForm((f) => ({ ...f, dailySendCap: e.target.value }))} className="w-full text-sm rounded-md border px-3 py-1.5 bg-background" />
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Break settings</p>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <label htmlFor="edit-break-every" className="text-xs text-muted-foreground">Break every (msgs)</label>
              <input id="edit-break-every" type="number" min={1} value={editForm.breakEvery} onChange={(e) => setEditForm((f) => ({ ...f, breakEvery: e.target.value }))} className="w-full text-sm rounded-md border px-3 py-1.5 bg-background" />
            </div>
            <div className="space-y-1">
              <label htmlFor="edit-break-min" className="text-xs text-muted-foreground">Min break (sec)</label>
              <input id="edit-break-min" type="number" min={1} value={editForm.breakMinMs} onChange={(e) => setEditForm((f) => ({ ...f, breakMinMs: e.target.value }))} className="w-full text-sm rounded-md border px-3 py-1.5 bg-background" />
            </div>
            <div className="space-y-1">
              <label htmlFor="edit-break-max" className="text-xs text-muted-foreground">Max break (sec)</label>
              <input id="edit-break-max" type="number" min={1} value={editForm.breakMaxMs} onChange={(e) => setEditForm((f) => ({ ...f, breakMaxMs: e.target.value }))} className="w-full text-sm rounded-md border px-3 py-1.5 bg-background" />
            </div>
          </div>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Typing speed (ms per keystroke)</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="edit-type-min" className="text-xs text-muted-foreground">Min delay (ms)</label>
              <input id="edit-type-min" type="number" min={1} value={editForm.typeDelayMin} onChange={(e) => setEditForm((f) => ({ ...f, typeDelayMin: e.target.value }))} className="w-full text-sm rounded-md border px-3 py-1.5 bg-background" />
            </div>
            <div className="space-y-1">
              <label htmlFor="edit-type-max" className="text-xs text-muted-foreground">Max delay (ms)</label>
              <input id="edit-type-max" type="number" min={1} value={editForm.typeDelayMax} onChange={(e) => setEditForm((f) => ({ ...f, typeDelayMax: e.target.value }))} className="w-full text-sm rounded-md border px-3 py-1.5 bg-background" />
            </div>
          </div>
        </div>
        <div className="space-y-1 pt-1">
          <label htmlFor="edit-warm-mode" className="flex items-center gap-3 cursor-pointer">
            <input
              id="edit-warm-mode"
              type="checkbox"
              checked={editForm.warmMode}
              disabled={editForm.validationOnly}
              onChange={(e) => setEditForm((f) => ({ ...f, warmMode: e.target.checked }))}
              className="rounded disabled:opacity-40"
            />
            <div>
              <p className={`text-sm font-medium ${editForm.validationOnly ? 'text-muted-foreground' : ''}`}>Warm Mode</p>
              <p className="text-xs text-muted-foreground">
                {editForm.validationOnly
                  ? 'Disabled — incompatible with Validation Only mode'
                  : 'Enable warm mode — agent will be excluded from campaigns and available for warming sessions'}
              </p>
            </div>
          </label>
        </div>
        <div className="space-y-1 pt-1">
          <label htmlFor="edit-validation-only" className="flex items-center gap-3 cursor-pointer">
            <input
              id="edit-validation-only"
              type="checkbox"
              checked={editForm.validationOnly}
              disabled={editForm.warmMode}
              onChange={(e) => setEditForm((f) => ({ ...f, validationOnly: e.target.checked }))}
              className="rounded disabled:opacity-40"
            />
            <div>
              <p className={`text-sm font-medium ${editForm.warmMode ? 'text-muted-foreground' : ''}`}>Hanya untuk Validasi</p>
              <p className="text-xs text-muted-foreground">
                {editForm.warmMode
                  ? 'Disabled — incompatible with Warm Mode'
                  : 'Agent hanya digunakan untuk phone-check (Validasi WA), tidak pernah dipakai untuk kirim kampanye'}
              </p>
            </div>
          </label>
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
          {/* Daily send cap */}
          <div className="space-y-1">
            <label htmlFor="add-daily-cap" className="text-xs font-medium text-muted-foreground">Daily send cap (messages/day)</label>
            <input id="add-daily-cap" type="number" min={1} value={form.dailySendCap} onChange={(e) => setForm((f) => ({ ...f, dailySendCap: e.target.value }))} className="w-full text-sm rounded-md border px-3 py-1.5 bg-background" />
          </div>
          {/* Break settings */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Break settings</p>
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
          {/* Typing speed */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Typing speed (ms per keystroke)</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor="add-type-min" className="text-xs text-muted-foreground">Min delay (ms)</label>
                <input id="add-type-min" type="number" min={1} value={form.typeDelayMin} onChange={(e) => setForm((f) => ({ ...f, typeDelayMin: e.target.value }))} className="w-full text-sm rounded-md border px-3 py-1.5 bg-background" />
              </div>
              <div className="space-y-1">
                <label htmlFor="add-type-max" className="text-xs text-muted-foreground">Max delay (ms)</label>
                <input id="add-type-max" type="number" min={1} value={form.typeDelayMax} onChange={(e) => setForm((f) => ({ ...f, typeDelayMax: e.target.value }))} className="w-full text-sm rounded-md border px-3 py-1.5 bg-background" />
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
              <div className={`shrink-0 rounded-md overflow-hidden border bg-muted flex items-center justify-center ${agent.status === 'QR' ? 'w-72 h-72' : 'w-40 h-28'}`}>
                {agent.screenshot ? (
                  <img
                    src={`data:image/jpeg;base64,${agent.screenshot}`}
                    alt={`${agent.name} preview`}
                    className={`w-full h-full ${agent.status === 'QR' ? 'object-contain' : 'object-cover'}`}
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">{agent.status === 'QR' ? 'Waiting for QR screenshot...' : 'No preview'}</span>
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
                  {agent.warmMode && (
                    <span className="text-xs bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded-full font-medium">
                      Warm Mode
                    </span>
                  )}
                  {agent.isWarmed && (
                    <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">
                      Warmed
                    </span>
                  )}
                  {agent.validationOnly && (
                    <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full font-medium">
                      Validation
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <div>Profile: <span className="font-mono">{agent.profilePath}</span></div>
                  <div>Department: {agent.departmentName ?? 'Shared pool'}</div>
                  <div>
                    Daily cap:{' '}
                    <span className="text-foreground font-medium">{agent.dailySendCap ?? config?.defaultDailySendCap ?? 150}</span> msgs/day
                    {' · '}
                    <span className={
                      Math.max(0, (agent.dailySendCap ?? config?.defaultDailySendCap ?? 150) - agent.sentToday) === 0
                        ? 'text-red-600 font-medium'
                        : 'text-green-700 font-medium'
                    }>
                      {Math.max(0, (agent.dailySendCap ?? config?.defaultDailySendCap ?? 150) - agent.sentToday)} remaining today
                    </span>
                  </div>
                  <div>
                    Break: every{' '}
                    <span className="text-foreground font-medium">{agent.breakEvery ?? config?.defaultBreakEvery ?? 30}</span> msgs,{' '}
                    <span className="text-foreground font-medium">{Math.round((agent.breakMinMs ?? (config ? config.defaultBreakMinSec * 1000 : 180000)) / 1000)}</span>–
                    <span className="text-foreground font-medium">{Math.round((agent.breakMaxMs ?? (config ? config.defaultBreakMaxSec * 1000 : 480000)) / 1000)}</span>s
                  </div>
                  <div>
                    Typing:{' '}
                    <span className="text-foreground font-medium">{agent.typeDelayMinMs ?? config?.defaultTypeDelayMin ?? 80}</span>–
                    <span className="text-foreground font-medium">{agent.typeDelayMaxMs ?? config?.defaultTypeDelayMax ?? 180}</span>ms/key
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
                {['OFFLINE', 'STARTING', 'ERROR'].includes(agent.status) ? (
                  <button
                    type="button"
                    onClick={() => startMutation.mutate(agent.id)}
                    disabled={startMutation.isPending}
                    className="bg-primary text-primary-foreground text-sm px-3 py-1.5 rounded-md disabled:opacity-50"
                  >
                    {agent.status === 'STARTING' ? 'Restart' : agent.status === 'ERROR' ? 'Retry' : 'Start'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => stopMutation.mutate(agent.id)}
                    disabled={stopMutation.isPending}
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
