import { useEffect, useState, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { apiFetch } from '@/lib/utils'
import type { CampaignStatus, MessageStatus } from '@aice/shared'

// ─── Fail-reason modal ────────────────────────────────────────────────────────

function FailReasonModal({ reason, onClose }: { reason: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/40 cursor-default"
        onClick={onClose}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      />
      {/* Panel */}
      <div className="relative bg-background rounded-lg shadow-lg border w-full max-w-md mx-4 p-6 space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-red-500 text-lg" aria-hidden="true">&#x26A0;</span>
          <h3 className="font-semibold text-sm">Pesan gagal dikirim</h3>
        </div>
        <p className="text-sm text-muted-foreground break-words">{reason}</p>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground"
          >
            Tutup
          </button>
        </div>
      </div>
    </div>
  )
}

interface Campaign {
  id: string
  name: string
  bulan: string
  status: CampaignStatus
  totalCount: number
  sentCount: number
  deliveredCount: number
  readCount: number
  failedCount: number
  replyCount: number
  startedAt: string | null
  completedAt: string | null
}

interface Message {
  id: string
  phone: string
  status: MessageStatus
  sentAt: string | null
  failReason: string | null
  contact: { storeName: string; seqNo: string | null }
  reply: { body: string; claudeCategory: string | null } | null
}

const STATUS_COLORS: Record<CampaignStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  RUNNING: 'bg-green-100 text-green-700',
  PAUSED: 'bg-yellow-100 text-yellow-700',
  COMPLETED: 'bg-blue-100 text-blue-700',
  CANCELLED: 'bg-red-100 text-red-600',
}

export default function CampaignDetail() {
  const { id } = useParams<{ id: string }>()
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [failModal, setFailModal] = useState<string | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)

  const loadCampaign = () =>
    apiFetch<Campaign>(`/api/campaigns/${id}`).then(setCampaign).catch(console.error)

  const loadMessages = (p = 1) =>
    apiFetch<{ messages: Message[]; total: number }>(`/api/campaigns/${id}/messages?page=${p}&limit=50`)
      .then((d) => { setMessages(d.messages); setTotal(d.total) })
      .catch(console.error)

  useEffect(() => {
    if (!id) return
    loadCampaign()
    loadMessages()

    // SSE for live updates
    const es = new EventSource(`/api/campaigns/${id}/events`)
    es.onmessage = (e) => {
      if (e.data) {
        loadCampaign()
        loadMessages(page)
      }
    }
    eventSourceRef.current = es
    return () => { es.close() }
  }, [id])

  const action = async (verb: 'enqueue' | 'pause' | 'resume' | 'cancel') => {
    await apiFetch(`/api/campaigns/${id}/${verb}`, { method: 'POST' }).catch(console.error)
    loadCampaign()
  }

  if (!campaign) return <div className="text-muted-foreground">Loading...</div>

  const totalPages = Math.ceil(total / 50)

  return (
    <>
    {failModal && <FailReasonModal reason={failModal} onClose={() => setFailModal(null)} />}
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{campaign.name}</h2>
          <p className="text-muted-foreground">Month: {campaign.bulan}</p>
        </div>
        <span className={`text-sm px-3 py-1 rounded-full font-medium ${STATUS_COLORS[campaign.status]}`}>
          {campaign.status}
        </span>
      </div>

      {/* Progress */}
      <div className="grid gap-4 md:grid-cols-5">
        {[
          { label: 'Total', value: campaign.totalCount, color: 'text-foreground' },
          { label: 'Sent', value: campaign.sentCount, color: 'text-blue-600' },
          { label: 'Delivered', value: campaign.deliveredCount, color: 'text-indigo-600' },
          { label: 'Read', value: campaign.readCount, color: 'text-green-600' },
          { label: 'Failed', value: campaign.failedCount, color: 'text-red-500' },
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
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{ width: `${(campaign.sentCount / campaign.totalCount) * 100}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground text-right">
            {Math.round((campaign.sentCount / campaign.totalCount) * 100)}% sent
          </p>
        </div>
      )}

      {/* Controls */}
      <div className="flex gap-2">
        {campaign.status === 'DRAFT' && (
          <button type="button" onClick={() => action('enqueue')} className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md">
            Start Campaign
          </button>
        )}
        {campaign.status === 'RUNNING' && (
          <button type="button" onClick={() => action('pause')} className="bg-yellow-500 text-white text-sm px-4 py-2 rounded-md">
            Pause
          </button>
        )}
        {campaign.status === 'PAUSED' && (
          <button type="button" onClick={() => action('resume')} className="bg-green-600 text-white text-sm px-4 py-2 rounded-md">
            Resume
          </button>
        )}
        {['RUNNING', 'PAUSED', 'DRAFT'].includes(campaign.status) && (
          <button type="button" onClick={() => action('cancel')} className="bg-destructive text-destructive-foreground text-sm px-4 py-2 rounded-md">
            Cancel
          </button>
        )}
      </div>

      {/* Message table */}
      <div className="rounded-lg border overflow-hidden">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h3 className="font-semibold text-sm">Messages</h3>
          <span className="text-xs text-muted-foreground">{total} total</span>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground text-xs uppercase tracking-wider">
            <tr>
              {['Store', 'Phone', 'Status', 'Sent At', 'Reply'].map((h) => (
                <th key={h} className="px-4 py-2.5 text-left font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {messages.map((m) => (
              <tr key={m.id} className="hover:bg-accent/50">
                <td className="px-4 py-2.5">{m.contact.storeName}</td>
                <td className="px-4 py-2.5 font-mono text-xs">{m.phone}</td>
                <td className="px-4 py-2.5">
                  {m.status === 'FAILED' && m.failReason ? (
                    <button
                      type="button"
                      title={m.failReason}
                      onClick={() => setFailModal(m.failReason)}
                      className="text-xs px-2 py-0.5 rounded-full font-medium bg-red-100 text-red-600 cursor-pointer underline-offset-2 hover:underline"
                    >
                      FAILED &#x2139;
                    </button>
                  ) : (
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      m.status === 'READ' ? 'bg-green-100 text-green-700'
                      : m.status === 'DELIVERED' ? 'bg-blue-100 text-blue-700'
                      : m.status === 'SENT' ? 'bg-indigo-100 text-indigo-700'
                      : m.status === 'FAILED' ? 'bg-red-100 text-red-600'
                      : 'bg-gray-100 text-gray-600'
                    }`}>{m.status}</span>
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
        <div className="flex items-center justify-between px-4 py-3 border-t text-sm">
          <button type="button" onClick={() => { setPage((p) => Math.max(1, p - 1)); loadMessages(page - 1) }} disabled={page <= 1} className="px-3 py-1 rounded border disabled:opacity-40">Previous</button>
          <span className="text-muted-foreground">Page {page} of {totalPages}</span>
          <button type="button" onClick={() => { setPage((p) => p + 1); loadMessages(page + 1) }} disabled={page >= totalPages} className="px-3 py-1 rounded border disabled:opacity-40">Next</button>
        </div>
      </div>
    </div>
    </>
  )
}
