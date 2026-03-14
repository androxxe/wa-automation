import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/utils'
import type { ReplyCategory, ReplySentiment } from '@aice/shared'

interface Reply {
  id: string
  body: string
  claudeCategory: ReplyCategory | null
  claudeSentiment: ReplySentiment | null
  claudeSummary: string | null
  receivedAt: string
  message: {
    phone: string
    sentAt: string | null
    body: string
    contact: { storeName: string; department: { name: string }; area: { name: string } }
  }
}

const CATEGORY_COLORS: Record<string, string> = {
  confirmed: 'bg-green-100 text-green-700',
  denied: 'bg-red-100 text-red-600',
  question: 'bg-yellow-100 text-yellow-700',
  unclear: 'bg-gray-100 text-gray-600',
  other: 'bg-blue-100 text-blue-700',
}

export default function Responses() {
  const [replies, setReplies] = useState<Reply[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // TODO: add proper /api/replies endpoint
    setLoading(false)
  }, [])

  async function handleExport() {
    window.open('/api/export/responses', '_blank')
  }

  async function handleWrite() {
    await apiFetch('/api/export/write', { method: 'POST' }).catch(console.error)
    alert('Files written to OUTPUT_FOLDER')
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Responses</h2>
          <p className="text-muted-foreground">Incoming replies analyzed by Claude</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={handleExport} className="text-sm px-4 py-2 rounded-md border">
            Export XLSX
          </button>
          <button type="button" onClick={handleWrite} className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md">
            Write to Output Folder
          </button>
        </div>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground text-xs uppercase tracking-wider">
            <tr>
              {['Store', 'Area', 'Dept', 'Message Sent', 'Reply', 'Category', 'Sentiment', 'Time'].map((h) => (
                <th key={h} className="px-4 py-2.5 text-left font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">Loading...</td></tr>
            )}
            {!loading && replies.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">No replies yet</td></tr>
            )}
            {replies.map((r) => (
              <tr key={r.id} className="hover:bg-accent/50">
                <td className="px-4 py-2.5 font-medium">{r.message.contact.storeName}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{r.message.contact.area.name}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{r.message.contact.department.name}</td>
                <td className="px-4 py-2.5 max-w-xs truncate text-xs" title={r.message.body}>
                  {r.message.body.slice(0, 50)}…
                </td>
                <td className="px-4 py-2.5 max-w-xs truncate" title={r.body}>{r.body}</td>
                <td className="px-4 py-2.5">
                  {r.claudeCategory && (
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CATEGORY_COLORS[r.claudeCategory] ?? ''}`}>
                      {r.claudeCategory}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground text-xs">{r.claudeSentiment ?? '—'}</td>
                <td className="px-4 py-2.5 text-muted-foreground text-xs">
                  {new Date(r.receivedAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
