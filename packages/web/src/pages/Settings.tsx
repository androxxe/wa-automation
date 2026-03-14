import { useEffect, useState, useRef } from 'react'
import { apiFetch } from '@/lib/utils'
import type { BrowserStatus } from '@aice/shared'

export default function Settings() {
  const [status, setStatus] = useState<BrowserStatus>('disconnected')
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const screenshotInterval = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadStatus = () =>
    apiFetch<{ status: BrowserStatus }>('/api/browser/status')
      .then((d) => setStatus(d.status))
      .catch(() => {})

  const loadScreenshot = () =>
    apiFetch<{ screenshot: string | null }>('/api/browser/screenshot')
      .then((d) => setScreenshot(d.screenshot))
      .catch(() => {})

  useEffect(() => {
    loadStatus()
    loadScreenshot()
    screenshotInterval.current = setInterval(loadScreenshot, 5000)
    return () => {
      if (screenshotInterval.current) clearInterval(screenshotInterval.current)
    }
  }, [])

  const handleStart = async () => {
    await apiFetch('/api/browser/start', { method: 'POST' }).catch(console.error)
    setTimeout(loadStatus, 2000)
  }

  const handleStop = async () => {
    await apiFetch('/api/browser/stop', { method: 'POST' }).catch(console.error)
    setTimeout(loadStatus, 1000)
  }

  const STATUS_DOT: Record<BrowserStatus, string> = {
    connected: 'bg-green-500',
    qr: 'bg-yellow-500',
    loading: 'bg-blue-500 animate-pulse',
    disconnected: 'bg-red-500',
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Settings</h2>
        <p className="text-muted-foreground">Browser session and configuration</p>
      </div>

      {/* Browser section */}
      <div className="rounded-lg border bg-card p-5 space-y-4">
        <h3 className="font-semibold">WhatsApp Browser Session</h3>

        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${STATUS_DOT[status]}`} />
          <span className="text-sm font-medium capitalize">{status}</span>
        </div>

        {/* Screenshot preview */}
        {screenshot ? (
          <div className="rounded-md overflow-hidden border">
            <img
              src={`data:image/jpeg;base64,${screenshot}`}
              alt="Browser preview"
              className="w-full object-cover max-h-72"
            />
          </div>
        ) : (
          <div className="rounded-md border bg-muted h-40 flex items-center justify-center text-sm text-muted-foreground">
            No screenshot available
          </div>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleStart}
            disabled={status === 'connected' || status === 'loading'}
            className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md disabled:opacity-50"
          >
            Open Browser
          </button>
          <button
            type="button"
            onClick={handleStop}
            disabled={status === 'disconnected'}
            className="border text-sm px-4 py-2 rounded-md disabled:opacity-50"
          >
            Close Browser
          </button>
          <button
            type="button"
            onClick={loadStatus}
            className="border text-sm px-4 py-2 rounded-md"
          >
            Refresh Status
          </button>
        </div>

        {status === 'qr' && (
          <div className="rounded-md border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
            WhatsApp Web is showing a QR code. Check the browser window and scan to authenticate.
          </div>
        )}
      </div>

      {/* Config display */}
      <div className="rounded-lg border bg-card p-5 space-y-3">
        <h3 className="font-semibold">Configuration (read-only)</h3>
        <div className="space-y-2 text-sm">
          {[
            ['Working hours', '08:00 – 17:00 WIB (Mon–Sat)'],
            ['Rate limit', '35s avg ±8s (Gaussian), floor 20s, ceiling 90s'],
            ['Daily cap', '150 messages/day'],
            ['Mid-session break', 'Every 30 messages → 3–8 min break'],
            ['Reply poll interval', '60s'],
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
