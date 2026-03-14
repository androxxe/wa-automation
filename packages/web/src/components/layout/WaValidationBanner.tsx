import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/utils'

interface QueueStatus {
  waiting: number
  active: number
  completed: number
  failed: number
  total: number
}

const POLL_INTERVAL_MS = 4000

export default function WaValidationBanner() {
  const [status, setStatus] = useState<QueueStatus | null>(null)

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const data = await apiFetch<QueueStatus>('/api/contacts/validate-wa/status')
        if (!cancelled) setStatus(data)
      } catch {
        // silently ignore — banner just won't show
      }
    }

    poll()
    const timer = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  // Only show while there are jobs in flight
  if (!status || status.total === 0) return null

  const { active, waiting } = status

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-blue-50 border-b border-blue-200 text-blue-800 text-sm">
      {/* Spinner */}
      <svg
        className="animate-spin h-4 w-4 shrink-0 text-blue-500"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>

      <span className="font-medium">Validasi WA sedang berjalan</span>
      <span className="text-blue-600">—</span>

      <span>
        <span className="font-semibold">{active}</span> sedang dicek,{' '}
        <span className="font-semibold">{waiting}</span> antrian tersisa
      </span>
    </div>
  )
}
