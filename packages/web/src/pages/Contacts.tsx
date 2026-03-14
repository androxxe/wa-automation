import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '@/lib/utils'

interface Contact {
  id: string
  seqNo: string | null
  storeName: string
  freezerId: string | null
  phoneRaw: string
  phoneNorm: string
  phoneValid: boolean
  waChecked: boolean
  exchangeCount: number | null
  department: { name: string }
  area: { name: string }
}

interface ContactsPage {
  contacts: Contact[]
  total: number
  page: number
  limit: number
}

// ─── WA status badge ─────────────────────────────────────────────────────────

function WaStatusBadge({ phoneValid, waChecked }: { phoneValid: boolean; waChecked: boolean }) {
  if (!phoneValid) {
    return (
      <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-600">
        Tidak valid
      </span>
    )
  }
  if (!waChecked) {
    return (
      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
        Belum dicek
      </span>
    )
  }
  return (
    <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">
      Terdaftar
    </span>
  )
}

export default function Contacts() {
  const [data, setData] = useState<ContactsPage | null>(null)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [validating, setValidating] = useState(false)
  const [validateMsg, setValidateMsg] = useState<string | null>(null)

  const loadContacts = useCallback(() => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(page), limit: '50' })

    // Map UI filter → API query params
    if (statusFilter === 'invalid')   params.set('phoneValid', 'false')
    if (statusFilter === 'valid')     { params.set('phoneValid', 'true'); params.set('waChecked', 'true') }
    if (statusFilter === 'unchecked') { params.set('phoneValid', 'true'); params.set('waChecked', 'false') }

    apiFetch<ContactsPage>(`/api/contacts?${params}`)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [page, statusFilter])

  useEffect(() => {
    loadContacts()
  }, [loadContacts])

  const handleValidateWA = async () => {
    setValidating(true)
    setValidateMsg(null)
    try {
      const result = await apiFetch<{ queued: number }>('/api/contacts/validate-wa', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      setValidateMsg(`${result.queued} nomor diantrekan untuk dicek. Status akan diperbarui otomatis.`)
      setTimeout(loadContacts, 3000)
    } catch (err) {
      setValidateMsg(`Gagal: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setValidating(false)
    }
  }

  const totalPages = data ? Math.ceil(data.total / 50) : 1

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Contacts</h2>
          <p className="text-muted-foreground">
            {data ? `${data.total.toLocaleString()} total` : 'Loading...'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
            className="text-sm border rounded-md px-3 py-1.5 bg-background"
          >
            <option value="">Semua</option>
            <option value="unchecked">Belum dicek</option>
            <option value="valid">Terdaftar</option>
            <option value="invalid">Tidak valid</option>
          </select>
          <button
            type="button"
            onClick={handleValidateWA}
            disabled={validating}
            className="text-sm border rounded-md px-3 py-1.5 bg-background disabled:opacity-50 hover:bg-accent transition-colors"
          >
            {validating ? 'Mengantrekan...' : 'Validasi WA'}
          </button>
        </div>
      </div>

      {validateMsg && (
        <div className="text-sm rounded-md border px-4 py-2.5 bg-muted text-muted-foreground">
          {validateMsg}
        </div>
      )}

      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground text-xs uppercase tracking-wider">
            <tr>
              {['No', 'Store Name', 'Department', 'Area', 'Phone (raw)', 'Phone (normalized)', 'Status WA', 'Exchange'].map((h) => (
                <th key={h} className="px-4 py-2.5 text-left font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">Loading...</td>
              </tr>
            )}
            {!loading && data?.contacts.map((c) => (
              <tr key={c.id} className="hover:bg-accent/50 transition-colors">
                <td className="px-4 py-2.5 font-mono text-xs">{c.seqNo ?? '—'}</td>
                <td className="px-4 py-2.5 font-medium">{c.storeName}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{c.department.name}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{c.area.name}</td>
                <td className="px-4 py-2.5 font-mono text-xs">{c.phoneRaw}</td>
                <td className="px-4 py-2.5 font-mono text-xs">{c.phoneNorm}</td>
                <td className="px-4 py-2.5">
                  <WaStatusBadge phoneValid={c.phoneValid} waChecked={c.waChecked} />
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{c.exchangeCount ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm">
        <button
          type="button"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
          className="px-3 py-1 rounded border disabled:opacity-40"
        >
          Previous
        </button>
        <span className="text-muted-foreground">Page {page} of {totalPages}</span>
        <button
          type="button"
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages}
          className="px-3 py-1 rounded border disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  )
}
