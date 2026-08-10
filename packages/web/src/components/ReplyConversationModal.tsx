import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/utils'
import type { ConversationEntry } from '@aice/shared'

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<ConversationEntry['status'], string> = {
  SENT:    'bg-green-100 text-green-700',
  FAILED:  'bg-red-100 text-red-600',
  BLOCKED: 'bg-orange-100 text-orange-700',
}

// ─── Screenshot viewer ────────────────────────────────────────────────────────

function ScreenshotView({ path, onClose }: { path: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70">
      <button
        type="button"
        aria-label="Close screenshot"
        className="absolute inset-0 w-full h-full cursor-default"
        onClick={onClose}
      />
      <div className="relative max-w-2xl w-full mx-4 z-10">
        <button
          type="button"
          onClick={onClose}
          className="absolute -top-8 right-0 text-white text-sm opacity-80 hover:opacity-100"
        >
          Close ✕
        </button>
        <img
          src={`/api/replies/screenshot?p=${encodeURIComponent(path)}`}
          alt="conversation screenshot"
          className="w-full rounded-lg shadow-2xl"
        />
      </div>
    </div>
  )
}

// ─── Conversation Thread + Reply Modal ────────────────────────────────────────

export default function ReplyConversationModal({
  replyId,
  phone,
  storeName,
  incomingBody,
  conversation,
  onClose,
  onRefresh,
}: {
  replyId:       string
  phone:         string
  storeName:     string
  incomingBody:  string
  conversation:  ConversationEntry[] | null
  onClose:       () => void
  onRefresh:     () => void
}) {
  const queryClient = useQueryClient()
  const [body, setBody]         = useState('')
  const [error, setError]       = useState<string | null>(null)
  const [screenshot, setScreenshot] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const sendMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ requestId: string; status: string; agentId?: number }>(
        '/api/messages/send',
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ phone, body, replyId }),
        },
      ),
    onSuccess: (data) => {
      setBody('')
      setError(null)
      alert(`Reply queued${data.agentId ? ` via agent ${data.agentId}` : ''}. Request: ${data.requestId}`)
      onRefresh()
      // Worker appends the conversation entry asynchronously — refresh again shortly after
      setTimeout(onRefresh, 3000)
    },
    onError: (e) => setError(String(e)),
  })

  const entries = conversation ?? []
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString('id-ID', {
      day:    '2-digit',
      month:  'short',
      hour:   '2-digit',
      minute: '2-digit',
    })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-background rounded-lg shadow-lg border w-full max-w-lg mx-4 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="px-5 pt-4 pb-3 border-b flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-base">Conversation — {storeName}</h3>
            <p className="text-xs text-muted-foreground font-mono">{phone}</p>
          </div>
          <button type="button" onClick={onClose} className="text-muted-foreground text-sm">×</button>
        </div>

        {error && (
          <div className="mx-5 mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
            {error}
          </div>
        )}

        {/* Thread */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 bg-muted/20">
          {/* Incoming (contact) bubble */}
          <div className="flex">
            <div className="max-w-[85%] bg-muted rounded-lg rounded-bl-none px-3 py-2 text-sm shadow-sm">
              <p className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wide">Reply dari toko</p>
              <p className="whitespace-pre-wrap break-words">{incomingBody}</p>
            </div>
          </div>

          {/* Outbound (operator) bubbles */}
          {entries.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4">Belum ada balasan terkirim.</p>
          )}
          {entries.map((e, i) => (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] bg-primary/10 rounded-lg rounded-br-none px-3 py-2 text-sm shadow-sm">
                <p className="whitespace-pre-wrap break-words">{e.body}</p>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${STATUS_STYLES[e.status] ?? 'bg-gray-100 text-gray-600'}`}>
                    {e.status}
                  </span>
                  <span className="text-[10px] text-muted-foreground">{fmt(e.sentAt)}</span>
                  {e.agentId !== undefined && (
                    <span className="text-[10px] text-muted-foreground">agent #{e.agentId}</span>
                  )}
                </div>
                {e.failReason && (
                  <p className="text-[10px] text-red-600 mt-1 break-words" title={e.failReason}>
                    {e.failReason}
                  </p>
                )}
                {e.screenshotPath && (
                  <button
                    type="button"
                    onClick={() => setScreenshot(e.screenshotPath!)}
                    className="mt-1.5 block"
                    title="View screenshot"
                  >
                    <img
                      src={`/api/replies/screenshot?p=${encodeURIComponent(e.screenshotPath)}`}
                      alt="sent reply screenshot"
                      className="h-24 w-auto rounded border cursor-pointer hover:opacity-80 transition-opacity"
                    />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Composer */}
        <div className="px-5 py-4 border-t space-y-2">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            maxLength={2048}
            placeholder="Tulis balasan… (bypass daily cap & working hours)"
            className="w-full border rounded-md px-3 py-2 bg-background text-sm resize-y"
          />
          <div className="flex justify-between items-center gap-2">
            <p className="text-xs text-muted-foreground">
              Kirim sebagai balasan ke {storeName} — lewat agent online.
            </p>
            <div className="flex gap-2 shrink-0">
              <button
                type="button"
                onClick={onRefresh}
                className="border text-sm px-3 py-1.5 rounded-md hover:bg-accent"
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={() => { setError(null); sendMutation.mutate() }}
                disabled={sendMutation.isPending || body.trim().length === 0}
                className="bg-primary text-primary-foreground text-sm px-4 py-1.5 rounded-md disabled:opacity-50"
              >
                {sendMutation.isPending ? 'Sending…' : 'Send reply'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {screenshot && <ScreenshotView path={screenshot} onClose={() => setScreenshot(null)} />}
    </div>
  )
}
