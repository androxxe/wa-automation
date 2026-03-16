import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/utils'
import type { ReplyCategory } from '@aice/shared'

interface Reply {
  id:              string
  body:            string
  claudeCategory:  ReplyCategory | null
  claudeSentiment: string | null
  receivedAt:      string
  message: {
    phone:  string
    sentAt: string | null
    body:   string
    contact: { storeName: string; department: { name: string }; area: { name: string } }
  }
}

interface Campaign {
  id:           string
  name:         string
  bulan:        string
  campaignType: string
}

const CATEGORY_COLORS: Record<string, string> = {
  confirmed: 'bg-green-100 text-green-700',
  denied:    'bg-red-100 text-red-600',
  question:  'bg-yellow-100 text-yellow-700',
  unclear:   'bg-gray-100 text-gray-600',
  other:     'bg-blue-100 text-blue-700',
}

export default function Responses() {
  const [selectedCampaignId, setSelectedCampaignId] = useState('')
  const [downloading, setDownloading]               = useState(false)

  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey: ['campaigns'],
    queryFn:  () => apiFetch<Campaign[]>('/api/campaigns'),
  })

  // TODO: replace with real /api/replies endpoint
  const replies: Reply[] = []

  function getSelectedCampaign() {
    return campaigns.find((c) => c.id === selectedCampaignId)
  }

  async function handleDownloadReportXlsx() {
    if (!selectedCampaignId) return
    setDownloading(true)
    try {
      const res = await fetch(`/api/export/report-xlsx?campaignId=${selectedCampaignId}`)
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        alert(`Download failed: ${(err as { error: string }).error}`)
        return
      }
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const c    = getSelectedCampaign()
      const a    = document.createElement('a')
      a.href     = url
      a.download = `laporan_${c?.campaignType ?? ''}_${c?.bulan ?? ''}_${new Date().toISOString().slice(0, 10)}.xlsx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      alert(`Download failed: ${String(err)}`)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Responses</h2>
          <p className="text-muted-foreground">Incoming replies analyzed by Claude</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => window.open('/api/export/responses', '_blank')} className="text-sm px-4 py-2 rounded-md border">
            Export XLSX
          </button>
          <button
            type="button"
            onClick={() => apiFetch('/api/export/write', { method: 'POST' }).then(() => alert('Files written to OUTPUT_FOLDER')).catch(console.error)}
            className="text-sm px-4 py-2 rounded-md border"
          >
            Write to Output Folder
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-4 py-3">
        <span className="text-sm font-medium shrink-0">Download Report (with screenshots)</span>
        <select
          value={selectedCampaignId}
          onChange={(e) => setSelectedCampaignId(e.target.value)}
          className="flex-1 max-w-xs text-sm rounded-md border bg-background px-3 py-1.5"
        >
          <option value="">— Pilih campaign —</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} — {c.bulan} — {c.campaignType}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleDownloadReportXlsx}
          disabled={!selectedCampaignId || downloading}
          className="shrink-0 text-sm px-4 py-2 rounded-md bg-primary text-primary-foreground disabled:opacity-50"
        >
          {downloading ? 'Generating…' : 'Download XLSX'}
        </button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground text-xs uppercase tracking-wider">
            <tr>
              {['Store', 'Area', 'Dept', 'Message Sent', 'Reply', 'Category', 'Time'].map((h) => (
                <th key={h} className="px-4 py-2.5 text-left font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {replies.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">No replies yet</td></tr>
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
