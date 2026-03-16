import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/utils'

interface Contact {
  id: string
  seqNo: string | null
  storeName: string
  freezerId: string | null
  phoneRaw: string
  phoneNorm: string
  contactType: string
  phoneValid: boolean
  waChecked: boolean
  waChecking: boolean
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

function WaStatusBadge({
  phoneValid,
  waChecked,
  waChecking,
}: {
  phoneValid:  boolean
  waChecked:   boolean
  waChecking:  boolean
}) {
  if (!phoneValid)  return <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-600">Tidak valid</span>
  if (waChecked)    return <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">Terdaftar</span>
  if (waChecking)   return (
    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-600 flex items-center gap-1 w-fit">
      <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
      </svg>
      Pending Checking
    </span>
  )
  return <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">Belum dicek</span>
}

export default function Contacts() {
  const queryClient = useQueryClient()
  const [page, setPage]               = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [typeFilter, setTypeFilter]   = useState('')
  const [validateMsg, setValidateMsg] = useState<string | null>(null)

  const params = new URLSearchParams({ page: String(page), limit: '50' })
  if (statusFilter === 'invalid')   params.set('phoneValid', 'false')
  if (statusFilter === 'valid')     { params.set('phoneValid', 'true'); params.set('waChecked', 'true') }
  if (statusFilter === 'unchecked') { params.set('phoneValid', 'true'); params.set('waChecked', 'false') }
  if (typeFilter)                   params.set('contactType', typeFilter)

  const { data, isLoading } = useQuery<ContactsPage>({
    queryKey: ['contacts', page, statusFilter, typeFilter],
    queryFn:  () => apiFetch<ContactsPage>(`/api/contacts?${params}`),
  })

  const validateMutation = useMutation({
    mutationFn: (recheck: boolean) =>
      apiFetch<{ queued: number }>('/api/contacts/validate-wa', {
        method: 'POST',
        body: JSON.stringify({ recheck }),
      }),
    onSuccess: (result, recheck) => {
      if (result.queued === 0) {
        setValidateMsg('Tidak ada nomor yang perlu dicek.')
      } else {
        setValidateMsg(
          `${result.queued} nomor diantrekan untuk dicek${recheck ? ' (ulang)' : ''}. Status akan diperbarui otomatis.`
        )
        // Refetch immediately to show "Pending Checking" badges, then again after 3s
        queryClient.invalidateQueries({ queryKey: ['contacts'] })
        setTimeout(() => queryClient.invalidateQueries({ queryKey: ['contacts'] }), 3000)
      }
    },
  })

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
            value={typeFilter}
            onChange={(e) => { setTypeFilter(e.target.value); setPage(1) }}
            className="text-sm border rounded-md px-3 py-1.5 bg-background"
          >
            <option value="">Semua Tipe</option>
            <option value="STIK">STIK</option>
            <option value="KARDUS">KARDUS</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
            className="text-sm border rounded-md px-3 py-1.5 bg-background"
          >
            <option value="">Semua Status</option>
            <option value="unchecked">Belum dicek</option>
            <option value="valid">Terdaftar</option>
            <option value="invalid">Tidak valid</option>
          </select>
          <button
            type="button"
            onClick={() => validateMutation.mutate(false)}
            disabled={validateMutation.isPending}
            title="Cek nomor yang belum pernah divalidasi"
            className="text-sm border rounded-md px-3 py-1.5 bg-background disabled:opacity-50 hover:bg-accent transition-colors"
          >
            {validateMutation.isPending ? 'Mengantrekan...' : 'Validasi WA'}
          </button>
          <button
            type="button"
            onClick={() => validateMutation.mutate(true)}
            disabled={validateMutation.isPending}
            title="Cek ulang semua nomor termasuk yang sudah divalidasi"
            className="text-sm border rounded-md px-3 py-1.5 bg-background disabled:opacity-50 hover:bg-accent transition-colors"
          >
            Cek Ulang Semua
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
              {['No', 'Store Name', 'Department', 'Area', 'Tipe', 'Phone (raw)', 'Phone (normalized)', 'Status WA', 'Exchange'].map((h) => (
                <th key={h} className="px-4 py-2.5 text-left font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">Loading...</td>
              </tr>
            )}
            {!isLoading && data?.contacts.map((c) => (
              <tr key={c.id} className="hover:bg-accent/50 transition-colors">
                <td className="px-4 py-2.5 font-mono text-xs">{c.seqNo ?? '—'}</td>
                <td className="px-4 py-2.5 font-medium">{c.storeName}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{c.department.name}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{c.area.name}</td>
                <td className="px-4 py-2.5">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    c.contactType === 'STIK' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'
                  }`}>
                    {c.contactType}
                  </span>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs">{c.phoneRaw}</td>
                <td className="px-4 py-2.5 font-mono text-xs">{c.phoneNorm}</td>
                <td className="px-4 py-2.5">
                  <WaStatusBadge phoneValid={c.phoneValid} waChecked={c.waChecked} waChecking={c.waChecking} />
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{c.exchangeCount ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
