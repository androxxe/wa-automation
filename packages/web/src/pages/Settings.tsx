import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/utils'
import type { AppConfigData } from '@aice/shared'

interface UnexpireResult { unexpired: number }

interface ManualPollResult {
  queued:  Array<{ phone: string; agentId: number }>
  skipped: Array<{ phone: string; reason: string }>
}

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
  const [manualPhones, setManualPhones]       = useState('')
  const [manualPollResult, setManualPollResult] = useState<ManualPollResult | null>(null)

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

  const togglePollMutation = useMutation({
    mutationFn: () =>
      apiFetch('/api/config', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          replyPollEnabled: !config?.replyPollEnabled,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config'] })
    },
  })

  const toggleSendMutation = useMutation({
    mutationFn: () =>
      apiFetch('/api/config', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          sendEnabled: !config?.sendEnabled,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config'] })
    },
  })

  const unexpireAllMutation = useMutation({
    mutationFn: () =>
      apiFetch<UnexpireResult>('/api/campaigns/unexpire-all', {
        method: 'POST',
      }),
    onSuccess: (result) => {
      alert(
        result.unexpired > 0
          ? `${result.unexpired} message${result.unexpired !== 1 ? 's' : ''} moved back to SENT for reply polling.`
          : 'No expired messages to unexpire.',
      )
      queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      queryClient.invalidateQueries({ queryKey: ['campaign'] })
      queryClient.invalidateQueries({ queryKey: ['campaign-messages'] })
    },
    onError: (e) => alert(String(e)),
  })

  const manualPollMutation = useMutation({
    mutationFn: (phones: string[]) =>
      apiFetch<ManualPollResult>('/api/replies/poll-manual', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ phones }),
      }),
    onSuccess: (result) => {
      setManualPollResult(result)
    },
    onError: (e) => alert(String(e)),
  })

  const handleManualPoll = () => {
    const phones = manualPhones
      .split(/[\n,]+/)
      .map((p) => p.trim())
      .filter(Boolean)

    if (phones.length === 0) {
      alert('Enter at least one phone number')
      return
    }
    if (phones.length > 100) {
      alert('Maximum 100 phone numbers per request')
      return
    }

    setManualPollResult(null)
    manualPollMutation.mutate(phones)
  }

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
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 className="font-semibold">Reply Polling</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Automatically scan WhatsApp Web for new replies every {config ? `${(config.replyPollIntervalMs / 1000).toFixed(0)}s` : '...'}.
              Disable to focus on sending only.
            </p>
          </div>
          <button
            type="button"
            onClick={() => togglePollMutation.mutate()}
            disabled={!config || togglePollMutation.isPending}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-50 ${
              config?.replyPollEnabled ? 'bg-primary' : 'bg-gray-300'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                config?.replyPollEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
        {config && (
          <div className={`text-xs font-medium px-2 py-1 rounded inline-block ${
            config.replyPollEnabled
              ? 'bg-green-100 text-green-700'
              : 'bg-amber-100 text-amber-700'
          }`}>
            {config.replyPollEnabled ? 'Enabled' : 'Disabled — sending only mode'}
          </div>
        )}
        {config && (
          <div className="flex items-center gap-3 pt-1">
            <label htmlFor="poll-concurrency" className="text-sm font-medium whitespace-nowrap">
              Concurrency
            </label>
            <select
              id="poll-concurrency"
              value={config.replyPollConcurrency}
              onChange={(e) => {
                const val = parseInt(e.target.value)
                apiFetch('/api/config', {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ replyPollConcurrency: val }),
                }).then(() => queryClient.invalidateQueries({ queryKey: ['config'] }))
              }}
              className="border rounded-md px-2 py-1 text-sm bg-background"
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>{n} agent{n > 1 ? 's' : ''}</option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">
              {config.replyPollConcurrency > 1
                ? 'Multiple agents poll simultaneously — may steal window focus on macOS'
                : 'Sequential — no focus steal'}
            </span>
          </div>
        )}
      </div>

      <div className="rounded-lg border bg-card p-5 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 className="font-semibold">Send Messages</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Pause or resume outgoing messages. Jobs stay queued and auto-resume when re-enabled.
            </p>
          </div>
          <button
            type="button"
            onClick={() => toggleSendMutation.mutate()}
            disabled={!config || toggleSendMutation.isPending}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-50 ${
              config?.sendEnabled ? 'bg-primary' : 'bg-gray-300'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                config?.sendEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
        {config && (
          <div className={`text-xs font-medium px-2 py-1 rounded inline-block ${
            config.sendEnabled
              ? 'bg-green-100 text-green-700'
              : 'bg-amber-100 text-amber-700'
          }`}>
            {config.sendEnabled ? 'Enabled' : 'Paused — jobs rescheduled every 5m until re-enabled'}
          </div>
        )}
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

      <div className="rounded-lg border bg-card p-5 space-y-3">
        <h3 className="font-semibold">Maintenance</h3>
        <p className="text-xs text-muted-foreground">
          Actions for recovering from issues. Use with care.
        </p>
        <div className="space-y-2">
          <div className="flex items-start gap-4">
            <div className="flex-1">
              <p className="text-sm font-medium">Unexpire all messages</p>
              <p className="text-xs text-muted-foreground">
                Moves all EXPIRED messages across every campaign back to SENT so they re-enter the reply polling pool.
                Use this if messages were expired before their replies could be checked (e.g. after a polling bug fix).
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                if (confirm('Unexpire ALL expired messages across every campaign? They will be moved back to SENT for reply polling.'))
                  unexpireAllMutation.mutate()
              }}
              disabled={unexpireAllMutation.isPending}
              className="border text-sm px-4 py-2 rounded-md hover:bg-accent disabled:opacity-50 whitespace-nowrap"
            >
              {unexpireAllMutation.isPending ? 'Unexpiring...' : 'Unexpire All'}
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-5 space-y-3">
        <h3 className="font-semibold">Manual Reply Poll</h3>
        <p className="text-xs text-muted-foreground">
          Enter phone numbers to manually trigger reply polling. Useful for catching replies that the automatic
          system missed (expired messages, agent offline, etc.). One number per line or comma-separated.
        </p>
        <textarea
          value={manualPhones}
          onChange={(e) => setManualPhones(e.target.value)}
          placeholder={'08123456789\n08234567890\n+6281345678901'}
          rows={5}
          className="w-full border rounded-md px-3 py-2 text-sm bg-background font-mono resize-y"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleManualPoll}
            disabled={manualPollMutation.isPending || !manualPhones.trim()}
            className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md disabled:opacity-50"
          >
            {manualPollMutation.isPending ? 'Queuing...' : 'Poll Replies'}
          </button>
          {manualPhones.trim() && (
            <span className="text-xs text-muted-foreground">
              {manualPhones.split(/[\n,]+/).map((p) => p.trim()).filter(Boolean).length} number(s)
            </span>
          )}
        </div>
        {manualPollResult && (
          <div className="space-y-2 text-sm">
            {manualPollResult.queued.length > 0 && (
              <div className="bg-green-50 border border-green-200 rounded-md px-3 py-2">
                <p className="font-medium text-green-800">
                  Queued {manualPollResult.queued.length} phone(s) for polling
                </p>
                <ul className="mt-1 text-xs text-green-700 space-y-0.5">
                  {manualPollResult.queued.map((q) => (
                    <li key={q.phone}>{q.phone} (agent #{q.agentId})</li>
                  ))}
                </ul>
              </div>
            )}
            {manualPollResult.skipped.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                <p className="font-medium text-amber-800">
                  Skipped {manualPollResult.skipped.length} phone(s)
                </p>
                <ul className="mt-1 text-xs text-amber-700 space-y-0.5">
                  {manualPollResult.skipped.map((s) => (
                    <li key={s.phone}>{s.phone} — {s.reason}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
