import { useEffect, useState, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/utils'
import type { CampaignStatus, MessageStatus, AreaEnqueuePreview } from '@aice/shared'

// ─── Fail-reason modal ────────────────────────────────────────────────────────

function FailReasonModal({ reason, onClose }: { reason: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-background rounded-lg shadow-lg border w-full max-w-md mx-4 p-6 space-y-4">
        <h3 className="font-semibold text-sm">Pesan gagal dikirim</h3>
        <p className="text-sm text-muted-foreground break-words">{reason}</p>
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground">
            Tutup
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Enqueue modal (two tabs: Preview + Select Contacts) ─────────────────────

interface PickerContact {
  id:                   string
  storeName:            string
  phoneNorm:            string
  seqNo:                string | null
  alreadyReplied:       boolean
  previousCampaignName: string | null
}

interface PickerArea {
  areaId:   string
  areaName: string
  contacts: PickerContact[]
}

function EnqueueModal({
  campaignId,
  preview,
  onConfirm,
  onClose,
  loading,
}: {
  campaignId: string
  preview:    AreaEnqueuePreview[]
  onConfirm:  (contactIds?: string[]) => void
  onClose:    () => void
  loading:    boolean
}) {
  const [tab, setTab]               = useState<'preview' | 'contacts'>('preview')
  const [pickerData, setPickerData] = useState<PickerArea[] | null>(null)
  const [pickerLoading, setPickerLoading] = useState(false)
  const [selected, setSelected]     = useState<Set<string>>(new Set())
  const [search, setSearch]         = useState('')

  // Load contacts when switching to the contacts tab
  async function loadContacts() {
    if (pickerData) return
    setPickerLoading(true)
    try {
      const data = await apiFetch<PickerArea[]>(`/api/campaigns/${campaignId}/contacts`)
      setPickerData(data)
      // Pre-select all non-already-replied contacts
      const ids = data.flatMap((a) => a.contacts.filter((c) => !c.alreadyReplied).map((c) => c.id))
      setSelected(new Set(ids))
    } catch (err) { console.error(err) }
    setPickerLoading(false)
  }

  function handleTabChange(t: 'preview' | 'contacts') {
    setTab(t)
    if (t === 'contacts') loadContacts()
  }

  function toggleContact(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleArea(area: PickerArea) {
    const enabled = area.contacts.filter((c) => !c.alreadyReplied)
    const allSel  = enabled.every((c) => selected.has(c.id))
    setSelected((prev) => {
      const next = new Set(prev)
      for (const c of enabled) allSel ? next.delete(c.id) : next.add(c.id)
      return next
    })
  }

  const totalEligible = pickerData?.flatMap((a) => a.contacts.filter((c) => !c.alreadyReplied)).length ?? 0
  const totalReplied  = pickerData?.flatMap((a) => a.contacts.filter((c) => c.alreadyReplied)).length ?? 0

  const filteredData = pickerData?.map((area) => ({
    ...area,
    contacts: search
      ? area.contacts.filter((c) => c.storeName.toLowerCase().includes(search.toLowerCase()) || c.phoneNorm.includes(search))
      : area.contacts,
  })).filter((a) => a.contacts.length > 0)

  function handleConfirm() {
    if (tab === 'contacts' && pickerData) {
      onConfirm(Array.from(selected))
    } else {
      onConfirm()
    }
  }

  const confirmCount = tab === 'contacts'
    ? selected.size
    : preview.reduce((s, r) => s + r.willSend, 0)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-background rounded-lg shadow-lg border w-full max-w-2xl mx-4 flex flex-col max-h-[90vh]">
        {/* Header + tabs */}
        <div className="px-6 pt-5 pb-0 border-b">
          <h3 className="font-semibold mb-3">Start Campaign</h3>
          <div className="flex gap-1">
            {(['preview', 'contacts'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => handleTabChange(t)}
                className={`text-sm px-4 py-1.5 rounded-t-md border-b-2 transition-colors ${
                  tab === t
                    ? 'border-primary text-primary font-medium'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t === 'preview' ? 'Preview' : 'Select Contacts'}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-6 space-y-4">

          {/* ── Preview tab ── */}
          {tab === 'preview' && (
            <>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted text-xs uppercase text-muted-foreground">
                    <tr>
                      {['Area', 'Total', 'Wrong Type', 'Not Validated', 'Ready', 'Will Send', 'Target'].map((h) => (
                        <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {preview.map((row) => (
                      <tr key={row.areaId} className={row.available === 0 ? 'bg-red-50/50' : row.warning ? 'bg-yellow-50/50' : ''}>
                        <td className="px-3 py-2 font-medium">{row.areaName}</td>
                        <td className="px-3 py-2 text-center text-muted-foreground">{row.totalInArea}</td>
                        <td className="px-3 py-2 text-center">
                          {row.wrongType > 0 ? <span className="text-xs text-orange-600">{row.wrongType}</span> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {row.notValidated > 0 ? <span className="text-xs text-yellow-600 font-medium">{row.notValidated} need WA check</span> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2 text-center font-semibold">
                          <span className={row.available === 0 ? 'text-red-600' : 'text-green-700'}>{row.available}</span>
                        </td>
                        <td className="px-3 py-2 text-center font-bold">{row.willSend}</td>
                        <td className="px-3 py-2 text-center text-muted-foreground">{row.target}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.some((r) => r.notValidated > 0) && (
                <p className="text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-3 py-2">
                  Some contacts haven't been WA-validated yet. Go to <strong>Contacts → Validasi WA</strong> first.
                </p>
              )}
            </>
          )}

          {/* ── Select Contacts tab ── */}
          {tab === 'contacts' && (
            <>
              {pickerLoading && <p className="text-sm text-muted-foreground text-center py-8">Loading contacts…</p>}

              {pickerData && (
                <>
                  {/* Search + counter */}
                  <div className="flex items-center gap-3">
                    <input
                      type="text"
                      placeholder="Search store name or phone…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="flex-1 text-sm border rounded-md px-3 py-1.5 bg-background"
                    />
                    <span className="text-xs text-muted-foreground shrink-0">
                      <span className="font-semibold text-foreground">{selected.size}</span> / {totalEligible} selected
                      {totalReplied > 0 && <span className="ml-1">({totalReplied} already replied)</span>}
                    </span>
                  </div>

                  {/* Contact list grouped by area */}
                  <div className="rounded-lg border divide-y overflow-y-auto max-h-96">
                    {filteredData?.length === 0 && (
                      <p className="px-4 py-6 text-sm text-muted-foreground text-center">No contacts match</p>
                    )}
                    {filteredData?.map((area) => {
                      const enabled  = area.contacts.filter((c) => !c.alreadyReplied)
                      const allSel   = enabled.length > 0 && enabled.every((c) => selected.has(c.id))
                      const someSel  = enabled.some((c) => selected.has(c.id))
                      return (
                        <div key={area.areaId}>
                          {/* Area header with select-all toggle */}
                          <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 sticky top-0">
                            <input
                              type="checkbox"
                              checked={allSel}
                              ref={(el) => { if (el) el.indeterminate = someSel && !allSel }}
                              onChange={() => toggleArea(area)}
                              disabled={enabled.length === 0}
                              className="rounded"
                            />
                            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex-1">{area.areaName}</span>
                            <span className="text-xs text-muted-foreground">
                              {enabled.filter((c) => selected.has(c.id)).length}/{enabled.length}
                            </span>
                          </div>
                          {/* Contacts */}
                          {area.contacts.map((c) => (
                            <div
                              key={c.id}
                              className={`flex items-center gap-3 px-6 py-2 text-sm ${c.alreadyReplied ? 'opacity-50' : 'hover:bg-accent/50'}`}
                            >
                              <input
                                type="checkbox"
                                checked={!c.alreadyReplied && selected.has(c.id)}
                                disabled={c.alreadyReplied}
                                onChange={() => toggleContact(c.id)}
                                className="rounded"
                              />
                              <span className="flex-1">{c.storeName}</span>
                              <span className="text-xs text-muted-foreground font-mono">{c.phoneNorm}</span>
                              {c.alreadyReplied && (
                                <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full">Replied</span>
                              )}
                              {!c.alreadyReplied && c.previousCampaignName && (
                                <span
                                  className="text-xs bg-blue-50 text-blue-600 border border-blue-200 px-1.5 py-0.5 rounded-full shrink-0"
                                  title={`Previously sent in: ${c.previousCampaignName}`}
                                >
                                  {c.previousCampaignName}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t flex justify-end gap-2">
          <button type="button" onClick={onClose} className="border text-sm px-4 py-2 rounded-md">Cancel</button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading || (tab === 'contacts' && selected.size === 0)}
            className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md disabled:opacity-50"
          >
            {loading ? 'Starting…' : `Confirm — send to ${confirmCount} contact${confirmCount !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface CampaignArea {
  areaId:        string
  sendLimit:     number | null
  sentCount:     number
  replyCount:    number
  targetReached: boolean
  area:          { name: string; department: { name: string } }
}

interface Campaign {
  id:           string
  name:         string
  bulan:        string
  campaignType: string
  status:       CampaignStatus
  totalCount:     number
  sentCount:      number
  deliveredCount: number
  readCount:      number
  failedCount:    number
  replyCount:     number
  cancelledCount: number
  expiredCount:   number
  targetRepliesPerArea: number | null
  areas:        CampaignArea[]
}

interface Message {
  id:         string
  phone:      string
  status:     MessageStatus
  sentAt:     string | null
  failReason: string | null
  contact:    { storeName: string }
  reply:      { body: string; claudeCategory: string | null } | null
  agent:      { name: string } | null
}

const STATUS_COLORS: Record<CampaignStatus, string> = {
  DRAFT:     'bg-gray-100 text-gray-600',
  RUNNING:   'bg-green-100 text-green-700',
  PAUSED:    'bg-yellow-100 text-yellow-700',
  COMPLETED: 'bg-blue-100 text-blue-700',
  CANCELLED: 'bg-red-100 text-red-600',
}

const MSG_STATUS_COLORS: Record<string, string> = {
  READ:      'bg-green-100 text-green-700',
  DELIVERED: 'bg-blue-100 text-blue-700',
  SENT:      'bg-indigo-100 text-indigo-700',
  FAILED:    'bg-red-100 text-red-600',
  CANCELLED: 'bg-gray-100 text-gray-500',
  QUEUED:    'bg-purple-100 text-purple-700',
  PENDING:   'bg-gray-100 text-gray-500',
  EXPIRED:   'bg-orange-100 text-orange-600',
}

export default function CampaignDetail() {
  const { id }        = useParams<{ id: string }>()
  const queryClient   = useQueryClient()
  const [page, setPage]           = useState(1)
  const [failModal, setFailModal] = useState<string | null>(null)
  const [preview, setPreview]     = useState<AreaEnqueuePreview[] | null>(null)
  const eventSourceRef            = useRef<EventSource | null>(null)

  const { data: campaign } = useQuery<Campaign>({
    queryKey: ['campaign', id],
    queryFn:  () => apiFetch<Campaign>(`/api/campaigns/${id}`),
    enabled:  !!id,
  })

  const { data: messagesData } = useQuery<{ messages: Message[]; total: number }>({
    queryKey: ['campaign-messages', id, page],
    queryFn:  () => apiFetch(`/api/campaigns/${id}/messages?page=${page}&limit=50`),
    enabled:  !!id,
  })
  const messages   = messagesData?.messages ?? []
  const total      = messagesData?.total ?? 0

  // SSE — invalidate queries on any event
  useEffect(() => {
    if (!id) return
    const es = new EventSource(`/api/campaigns/${id}/events`)
    es.onmessage = () => {
      queryClient.invalidateQueries({ queryKey: ['campaign', id] })
      queryClient.invalidateQueries({ queryKey: ['campaign-messages', id] })
    }
    eventSourceRef.current = es
    return () => es.close()
  }, [id, queryClient])

  const previewMutation = useMutation({
    mutationFn: () => apiFetch<AreaEnqueuePreview[]>(`/api/campaigns/${id}/enqueue?preview=true`, { method: 'POST' }),
    onSuccess:  (rows) => setPreview(rows),
    onError:    (e) => alert(String(e)),
  })

  const enqueueMutation = useMutation({
    mutationFn: (contactIds?: string[]) =>
      apiFetch(`/api/campaigns/${id}/enqueue`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(contactIds ? { contactIds } : {}),
      }),
    onSuccess: () => {
      setPreview(null)
      queryClient.invalidateQueries({ queryKey: ['campaign', id] })
      queryClient.invalidateQueries({ queryKey: ['campaign-messages', id] })
    },
    onError: (e) => alert(String(e)),
  })

  const actionMutation = useMutation({
    mutationFn: (verb: 'pause' | 'resume' | 'cancel') =>
      apiFetch(`/api/campaigns/${id}/${verb}`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['campaign', id] }),
  })

  const topupMutation = useMutation({
    mutationFn: ({ areaId, count }: { areaId?: string; count?: number }) =>
      apiFetch<{ totalEnqueued: number; areas: { areaName: string; enqueued: number; skipped: string | null }[] }>(
        `/api/campaigns/${id}/topup`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(areaId ? { areaId } : {}), ...(count ? { count } : {}) }) },
      ),
    onSuccess: (result) => {
      const summary = result.areas.filter((a) => a.enqueued > 0).map((a) => `${a.areaName}: +${a.enqueued}`).join(', ')
      alert(summary ? `Top-up queued: ${summary}` : 'No fresh contacts available to top up.')
      queryClient.invalidateQueries({ queryKey: ['campaign', id] })
    },
    onError: (e) => alert(String(e)),
  })

  const promptTopup = (areaId?: string) => {
    const input = prompt('How many contacts to top up per area?\n(Leave empty to use default formula)')
    if (input === null) return // cancelled
    const count = input.trim() === '' ? undefined : parseInt(input, 10)
    if (count !== undefined && (isNaN(count) || count <= 0)) {
      alert('Please enter a valid positive number.')
      return
    }
    topupMutation.mutate({ areaId, count })
  }

  const deleteMessageMutation = useMutation({
    mutationFn: (messageId: string) =>
      apiFetch(`/api/campaigns/${id}/messages/${messageId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaign', id] })
      queryClient.invalidateQueries({ queryKey: ['campaign-messages', id] })
    },
    onError: (e) => alert(String(e)),
  })

  const retryFailedMutation = useMutation({
    mutationFn: (messageIds?: string[]) =>
      apiFetch<{ retried: number; skipped: number }>(
        `/api/campaigns/${id}/retry-failed`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(messageIds ? { messageIds } : {}) },
      ),
    onSuccess: (result) => {
      const msg = result.retried > 0
        ? `${result.retried} message${result.retried !== 1 ? 's' : ''} re-queued${result.skipped > 0 ? `, ${result.skipped} skipped (invalid phone)` : ''}.`
        : result.skipped > 0 ? 'All failed messages have invalid phone numbers and cannot be retried.' : 'No failed messages to retry.'
      alert(msg)
      queryClient.invalidateQueries({ queryKey: ['campaign', id] })
      queryClient.invalidateQueries({ queryKey: ['campaign-messages', id] })
    },
    onError: (e) => alert(String(e)),
  })

  const unexpireMutation = useMutation({
    mutationFn: (messageIds?: string[]) =>
      apiFetch<{ unexpired: number }>(
        `/api/campaigns/${id}/unexpire`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(messageIds ? { messageIds } : {}) },
      ),
    onSuccess: (result) => {
      alert(result.unexpired > 0
        ? `${result.unexpired} message${result.unexpired !== 1 ? 's' : ''} moved back to SENT for reply polling.`
        : 'No expired messages to unexpire.')
      queryClient.invalidateQueries({ queryKey: ['campaign', id] })
      queryClient.invalidateQueries({ queryKey: ['campaign-messages', id] })
    },
    onError: (e) => alert(String(e)),
  })

  if (!campaign) return <div className="text-muted-foreground py-8 text-center">Loading…</div>

  const totalPages = Math.ceil(total / 50)

  return (
    <>
      {failModal && <FailReasonModal reason={failModal} onClose={() => setFailModal(null)} />}
      {preview && id && (
        <EnqueueModal
          campaignId={id}
          preview={preview}
          onConfirm={(contactIds) => enqueueMutation.mutate(contactIds)}
          onClose={() => setPreview(null)}
          loading={enqueueMutation.isPending}
        />
      )}

      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">{campaign.name}</h2>
            <p className="text-muted-foreground">
              {campaign.bulan} — <span className="font-medium">{campaign.campaignType}</span>
            </p>
          </div>
          <span className={`text-sm px-3 py-1 rounded-full font-medium ${STATUS_COLORS[campaign.status]}`}>
            {campaign.status}
          </span>
        </div>

        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-8">
          {[
            { label: 'Total',     value: campaign.totalCount,     color: 'text-foreground' },
            { label: 'Sent',      value: campaign.sentCount,      color: 'text-blue-600' },
            { label: 'Delivered', value: campaign.deliveredCount, color: 'text-indigo-600' },
            { label: 'Read',      value: campaign.readCount,      color: 'text-green-600' },
            { label: 'Failed',    value: campaign.failedCount,    color: 'text-red-500' },
            { label: 'Cancelled', value: campaign.cancelledCount, color: 'text-orange-500' },
            { label: 'Expired',   value: campaign.expiredCount,   color: 'text-orange-600' },
            { label: 'Replies',   value: campaign.replyCount,     color: 'text-purple-600' },
          ].map(({ label, value, color }) => (
            <div key={label} className="rounded-lg border bg-card p-4 text-center">
              <p className={`text-2xl font-bold ${color}`}>{value}</p>
              <p className="text-xs text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>

        {/* Progress bar */}
        {campaign.totalCount > 0 && (
          <div className="space-y-1">
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${(campaign.sentCount / campaign.totalCount) * 100}%` }} />
            </div>
            <p className="text-xs text-muted-foreground text-right">
              {Math.round((campaign.sentCount / campaign.totalCount) * 100)}% sent
            </p>
          </div>
        )}

        {/* Controls */}
        <div className="flex gap-2">
          {campaign.status === 'DRAFT' && (
            <button
              type="button"
              onClick={() => previewMutation.mutate()}
              disabled={previewMutation.isPending}
              className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md disabled:opacity-50"
            >
              {previewMutation.isPending ? 'Loading preview…' : 'Start Campaign'}
            </button>
          )}
          {campaign.status === 'RUNNING' && (
            <button type="button" onClick={() => actionMutation.mutate('pause')} className="bg-yellow-500 text-white text-sm px-4 py-2 rounded-md">Pause</button>
          )}
          {campaign.status === 'PAUSED' && (
            <button type="button" onClick={() => actionMutation.mutate('resume')} className="bg-green-600 text-white text-sm px-4 py-2 rounded-md">Resume</button>
          )}
          {['RUNNING', 'PAUSED', 'DRAFT'].includes(campaign.status) && (
            <button type="button" onClick={() => actionMutation.mutate('cancel')} className="bg-destructive text-destructive-foreground text-sm px-4 py-2 rounded-md">Cancel</button>
          )}
          {campaign.failedCount > 0 && campaign.status !== 'CANCELLED' && (
            <button
              type="button"
              onClick={() => retryFailedMutation.mutate(undefined)}
              disabled={retryFailedMutation.isPending}
              className="border text-sm px-4 py-2 rounded-md hover:bg-accent disabled:opacity-50"
            >
              {retryFailedMutation.isPending ? 'Retrying…' : `Retry Failed (${campaign.failedCount})`}
            </button>
          )}
          {campaign.expiredCount > 0 && !['CANCELLED', 'DRAFT'].includes(campaign.status) && (
            <button
              type="button"
              onClick={() => { if (confirm(`Unexpire ${campaign.expiredCount} expired message(s)? They will be moved back to SENT for reply polling.`)) unexpireMutation.mutate(undefined) }}
              disabled={unexpireMutation.isPending}
              className="border text-sm px-4 py-2 rounded-md hover:bg-accent disabled:opacity-50"
            >
              {unexpireMutation.isPending ? 'Unexpiring…' : `Unexpire (${campaign.expiredCount})`}
            </button>
          )}
        </div>

        {/* Per-area progress */}
        {campaign.areas.length > 0 && (
          <div className="rounded-lg border overflow-hidden">
            <div className="px-4 py-3 border-b bg-muted/30 flex items-center justify-between">
              <h3 className="font-semibold text-sm">Per-area progress</h3>
              {['RUNNING', 'PAUSED'].includes(campaign.status) && (
                <button
                   type="button"
                   onClick={() => promptTopup(undefined)}
                   disabled={topupMutation.isPending}
                   className="text-xs border px-2.5 py-1 rounded-md hover:bg-accent disabled:opacity-50"
                 >
                   Top-up all areas
                 </button>
              )}
            </div>
            <table className="w-full text-sm">
              <thead className="bg-muted text-xs uppercase text-muted-foreground">
                <tr>
                  {['Area', 'Department', 'Sent', 'Replies', 'Target', 'Status', ''].map((h) => (
                    <th key={h} className="px-4 py-2 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {campaign.areas.map((ca) => {
                  const target     = campaign.targetRepliesPerArea ?? 20
                  const reached    = ca.targetReached
                  const allSent    = ca.sendLimit !== null && ca.sentCount >= ca.sendLimit
                  const shortfall  = target - ca.replyCount
                  const needsTopup = allSent && !reached && shortfall > 0

                  return (
                    <tr key={ca.areaId} className={needsTopup ? 'bg-yellow-50/50' : ''}>
                      <td className="px-4 py-2.5">{ca.area.name}</td>
                      <td className="px-4 py-2.5 text-muted-foreground text-xs">{ca.area.department.name}</td>
                      <td className="px-4 py-2.5 text-center">{ca.sentCount} / {ca.sendLimit ?? '?'}</td>
                      <td className="px-4 py-2.5 text-center font-semibold">{ca.replyCount}</td>
                      <td className="px-4 py-2.5 text-center text-muted-foreground">{target}</td>
                      <td className="px-4 py-2.5">
                        {reached ? (
                          <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">Target reached</span>
                        ) : needsTopup ? (
                          <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full font-medium">Short by {shortfall}</span>
                        ) : (
                          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">Running</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {needsTopup && ['RUNNING', 'PAUSED'].includes(campaign.status) && (
                          <button
                            type="button"
                            onClick={() => promptTopup(ca.areaId)}
                            disabled={topupMutation.isPending}
                            className="text-xs border px-2 py-0.5 rounded hover:bg-accent disabled:opacity-50"
                          >
                            Top-up
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Message table */}
        <div className="rounded-lg border overflow-hidden">
          <div className="px-4 py-3 border-b flex items-center justify-between">
            <h3 className="font-semibold text-sm">Messages</h3>
            <span className="text-xs text-muted-foreground">{total} total</span>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-muted text-xs uppercase text-muted-foreground">
              <tr>
                {['Store', 'Phone', 'Agent', 'Status', 'Sent At', 'Reply'].map((h) => (
                  <th key={h} className="px-4 py-2.5 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {messages.map((m) => (
                <tr key={m.id} className={`hover:bg-accent/50 ${m.status === 'CANCELLED' ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-2.5">{m.contact.storeName}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{m.phone}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{m.agent?.name ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    {m.status === 'FAILED' ? (
                      <div className="flex items-center gap-1">
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-red-100 text-red-600">FAILED</span>
                        {m.failReason && (
                          <button
                            type="button"
                            onClick={() => setFailModal(m.failReason!)}
                            className="text-xs text-red-500 hover:underline"
                            title="View fail reason"
                          >
                            &#x2139;
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => retryFailedMutation.mutate([m.id])}
                          disabled={retryFailedMutation.isPending || deleteMessageMutation.isPending}
                          className="text-xs px-1.5 py-0.5 rounded border border-gray-300 hover:bg-accent disabled:opacity-50"
                          title="Retry this message"
                        >
                          Retry
                        </button>
                        <button
                          type="button"
                          onClick={() => { if (confirm('Cancel this message?')) deleteMessageMutation.mutate(m.id) }}
                          disabled={deleteMessageMutation.isPending}
                          className="text-xs px-1.5 py-0.5 rounded border border-gray-300 text-gray-500 hover:bg-accent disabled:opacity-50"
                          title="Cancel this message"
                        >
                          &#x2715;
                        </button>
                      </div>
                    ) : m.status === 'EXPIRED' ? (
                      <div className="flex items-center gap-1">
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-orange-100 text-orange-600">EXPIRED</span>
                        <button
                          type="button"
                          onClick={() => { if (confirm('Unexpire this message? It will be moved back to SENT for reply polling.')) unexpireMutation.mutate([m.id]) }}
                          disabled={unexpireMutation.isPending}
                          className="text-xs px-1.5 py-0.5 rounded border border-gray-300 hover:bg-accent disabled:opacity-50"
                          title="Unexpire — move back to SENT for reply polling"
                        >
                          Unexpire
                        </button>
                      </div>
                    ) : m.status === 'QUEUED' ? (
                      <div className="flex items-center gap-1">
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-purple-100 text-purple-700">QUEUED</span>
                        <button
                          type="button"
                          onClick={() => { if (confirm('Cancel this message?')) deleteMessageMutation.mutate(m.id) }}
                          disabled={deleteMessageMutation.isPending}
                          className="text-xs px-1.5 py-0.5 rounded border border-gray-300 text-gray-500 hover:bg-accent disabled:opacity-50"
                          title="Cancel this message"
                        >
                          &#x2715;
                        </button>
                      </div>
                    ) : (
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${MSG_STATUS_COLORS[m.status] ?? 'bg-gray-100 text-gray-600'}`}>
                        {m.status}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground text-xs">
                    {m.sentAt ? new Date(m.sentAt).toLocaleTimeString() : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-xs max-w-xs truncate">
                    {m.reply ? (
                      <span title={m.reply.body}>
                        <span className="text-muted-foreground">[{m.reply.claudeCategory ?? 'pending'}]</span>{' '}
                        {m.reply.body.slice(0, 40)}{m.reply.body.length > 40 ? '…' : ''}
                      </span>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t text-sm">
              <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-3 py-1 rounded border disabled:opacity-40">Previous</button>
              <span className="text-muted-foreground">Page {page} of {totalPages}</span>
              <button type="button" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="px-3 py-1 rounded border disabled:opacity-40">Next</button>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
