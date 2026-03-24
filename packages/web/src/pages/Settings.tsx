import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/utils'
import type { AppConfigData } from '@aice/shared'

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

function formatDays(days: number[]): string {
  if (days.length === 7) return 'Every day'
  if (days.length === 6 && !days.includes(7)) return 'Mon–Sat'
  if (days.length === 5 && days.every((d) => d >= 1 && d <= 5)) return 'Mon–Fri'

  const sorted = [...days].sort((a, b) => a - b)

  // Check for consecutive range
  const isConsecutive = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1)
  if (isConsecutive && sorted.length >= 3) {
    return `${DAY_NAMES[sorted[0]]}–${DAY_NAMES[sorted[sorted.length - 1]]}`
  }

  return sorted.map((d) => DAY_NAMES[d]).join(', ')
}

export default function Settings() {
  const queryClient = useQueryClient()
  const [target, setTarget] = useState('')
  const [rate, setRate]     = useState('')
  const [saved, setSaved]   = useState(false)

  const { data: config } = useQuery<AppConfigData>({
    queryKey: ['config'],
    queryFn:  () => apiFetch<AppConfigData>('/api/config'),
  })

  // Sync local form state when config loads
  useEffect(() => {
    if (config) {
      setTarget(String(config.defaultTargetRepliesPerArea))
      setRate(String(Math.round(config.defaultExpectedReplyRate * 100)))
    }
  }, [config])

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch('/api/config', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          defaultTargetRepliesPerArea: parseInt(target),
          defaultExpectedReplyRate:    parseFloat(rate) / 100,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    },
  })

  const effectiveTarget = parseInt(target) || 20
  const effectiveRate   = parseFloat(rate) / 100 || 0.5
  const sendPerArea     = Math.ceil(effectiveTarget / effectiveRate)

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Settings</h2>
        <p className="text-muted-foreground">Global configuration and campaign defaults</p>
      </div>

      <div className="rounded-lg border bg-card p-5 space-y-4">
        <h3 className="font-semibold">Campaign Defaults</h3>
        <p className="text-xs text-muted-foreground">
          These values are pre-filled when creating a new campaign. Each campaign can override them.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label htmlFor="default-target" className="text-sm font-medium">Target replies per area</label>
            <input
              id="default-target"
              type="number"
              min={1}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="w-full border rounded-md px-3 py-1.5 text-sm bg-background"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="default-rate" className="text-sm font-medium">Expected reply rate (%)</label>
            <input
              id="default-rate"
              type="number"
              min={1}
              max={100}
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              className="w-full border rounded-md px-3 py-1.5 text-sm bg-background"
            />
          </div>
        </div>
        <div className="text-sm text-muted-foreground bg-muted rounded px-3 py-2">
          Messages to send per area:{' '}
          <span className="font-semibold text-foreground">{sendPerArea}</span>
          {' '}= ceil({effectiveTarget} ÷ {Math.round(effectiveRate * 100)}%)
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !target || !rate}
            className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md disabled:opacity-50"
          >
            {saveMutation.isPending ? 'Saving…' : 'Save'}
          </button>
          {saved && <span className="text-sm text-green-600">Saved!</span>}
        </div>
      </div>

      <div className="rounded-lg border bg-card p-5 space-y-3">
        <h3 className="font-semibold">Browser Agents</h3>
        <p className="text-sm text-muted-foreground">
          Manage WhatsApp browser agents (start/stop, view QR codes, view screenshots) from the Agents page.
        </p>
        <Link to="/agents" className="inline-block bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md">
          Go to Agents
        </Link>
      </div>

      <div className="rounded-lg border bg-card p-5 space-y-3">
        <h3 className="font-semibold">Configuration (read-only)</h3>
        <p className="text-xs text-muted-foreground">
          Values from the active environment file. Restart the API server to apply changes.
        </p>
        {config ? (
          <div className="space-y-2 text-sm">
            {([
              ['Working hours',        `${config.workingHoursStart} – ${config.workingHoursEnd} ${config.timezone} (${formatDays(config.workingDays)})`],
              ['Rate limit',           `${(config.rateLimitMeanMs / 1000).toFixed(0)}s avg ±${(config.rateLimitStddevMs / 1000).toFixed(0)}s (Gaussian), floor ${(config.rateLimitMinMs / 1000).toFixed(0)}s, ceiling ${(config.rateLimitMaxMs / 1000).toFixed(0)}s`],
              ['Daily cap',            `${config.defaultDailySendCap} messages/day per agent`],
              ['Mid-session break',    `Every ${config.defaultBreakEvery} messages → ${Math.round(config.defaultBreakMinSec / 60)}–${Math.round(config.defaultBreakMaxSec / 60)} min break`],
              ['Reply poll interval',  `${(config.replyPollIntervalMs / 1000).toFixed(0)}s`],
              ['Reply window',       `${config.campaignReplyWindowDays} days after campaign completes`],
              ['Phone check concurrency', `${config.phoneCheckConcurrency} parallel jobs`],
            ] as const).map(([k, v]) => (
              <div key={k} className="flex justify-between border-b pb-2 last:border-0 last:pb-0">
                <span className="text-muted-foreground">{k}</span>
                <span className="font-mono text-xs">{v}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Loading...</p>
        )}
      </div>
    </div>
  )
}
