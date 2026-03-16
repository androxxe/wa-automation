import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '@/lib/utils'
import type { AppConfigData } from '@aice/shared'

export default function Settings() {
  const [config, setConfig]       = useState<AppConfigData | null>(null)
  const [target, setTarget]       = useState('')
  const [rate, setRate]           = useState('')
  const [saving, setSaving]       = useState(false)
  const [saved, setSaved]         = useState(false)

  const loadConfig = useCallback(() => {
    apiFetch<AppConfigData>('/api/config')
      .then((d) => {
        setConfig(d)
        setTarget(String(d.defaultTargetRepliesPerArea))
        setRate(String(Math.round(d.defaultExpectedReplyRate * 100)))
      })
      .catch(console.error)
  }, [])

  useEffect(() => { loadConfig() }, [loadConfig])

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    try {
      await apiFetch('/api/config', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          defaultTargetRepliesPerArea: parseInt(target),
          defaultExpectedReplyRate:    parseFloat(rate) / 100,
        }),
      })
      await loadConfig()
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (err) {
      alert(String(err))
    }
    setSaving(false)
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

      {/* Campaign defaults */}
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
            onClick={handleSave}
            disabled={saving || !target || !rate}
            className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved && <span className="text-sm text-green-600">Saved!</span>}
        </div>
      </div>

      {/* Agents link */}
      <div className="rounded-lg border bg-card p-5 space-y-3">
        <h3 className="font-semibold">Browser Agents</h3>
        <p className="text-sm text-muted-foreground">
          Manage WhatsApp browser agents (start/stop, view QR codes, view screenshots) from the Agents page.
        </p>
        <Link to="/agents" className="inline-block bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md">
          Go to Agents
        </Link>
      </div>

      {/* Read-only config */}
      <div className="rounded-lg border bg-card p-5 space-y-3">
        <h3 className="font-semibold">Configuration (read-only)</h3>
        <div className="space-y-2 text-sm">
          {[
            ['Working hours',      '08:00 – 17:00 WIB (Mon–Sat)'],
            ['Rate limit',         '35s avg ±8s (Gaussian), floor 20s, ceiling 90s'],
            ['Daily cap',          '150 messages/day per agent'],
            ['Mid-session break',  'Every 30 messages → 3–8 min break'],
            ['Reply poll interval','60s'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between border-b pb-2 last:border-0 last:pb-0">
              <span className="text-muted-foreground">{k}</span>
              <span className="font-mono text-xs">{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
