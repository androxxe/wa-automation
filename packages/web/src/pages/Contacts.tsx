import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/utils'
import ValidasiModal from '@/components/ValidasiModal'

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

interface Area {
  id: string
  name: string
  contactType: string
}

// ─── WA Status Badge ──────────────────────────────────────────────────────────

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

// ─── Area Combobox ────────────────────────────────────────────────────────────

function AreaPicker({
  value,
  onChange,
  areas,
}: {
  value:    string
  onChange: (id: string) => void
  areas:    Area[]
}) {
  const [search, setSearch] = useState('')
  const [open,   setOpen]   = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const selected = areas.find((a) => a.id === value)
  const filtered = areas.filter((a) =>
    a.name.toLowerCase().includes(search.toLowerCase())
  )

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-sm rounded-md border bg-background px-3 py-1.5 text-left flex items-center gap-2 min-w-[160px]"
      >
        <span className={selected ? 'truncate' : 'text-muted-foreground truncate'}>
          {selected ? selected.name : 'Semua Area'}
        </span>
        <span className="text-xs opacity-60 shrink-0 ml-auto">▾</span>
      </button>

      {open && (
        <div className="absolute z-30 left-0 top-full mt-1 w-full min-w-[200px] rounded-lg border bg-popover shadow-md">
          <div className="p-2 border-b">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari area…"
              ref={(el) => { if (el) el.focus() }}
              className="w-full text-sm rounded border bg-background px-2 py-1 outline-none"
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            {value && (
              <button
                type="button"
                className="w-full text-left text-sm px-3 py-2 hover:bg-accent text-muted-foreground"
                onClick={() => { onChange(''); setOpen(false); setSearch('') }}
              >
                — Semua Area —
              </button>
            )}
            {filtered.length === 0 && (
              <p className="text-sm text-muted-foreground px-3 py-4 text-center">Tidak ditemukan</p>
            )}
            {filtered.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`w-full text-left text-sm px-3 py-2 hover:bg-accent ${a.id === value ? 'bg-accent/60 font-medium' : ''}`}
                onClick={() => { onChange(a.id); setOpen(false); setSearch('') }}
              >
                {a.name}
                <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full font-medium ${
                  a.contactType === 'STIK' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'
                }`}>
                  {a.contactType}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Contacts() {
  const queryClient = useQueryClient()
  const [page, setPage]                       = useState(1)
  const [statusFilter, setStatusFilter]       = useState('')
  const [typeFilter, setTypeFilter]           = useState('')
  const [areaFilter, setAreaFilter]           = useState('')
  const [validateMsg, setValidateMsg]         = useState<string | null>(null)
  const [validasiModalOpen, setValidasiModal] = useState(false)

  const { data: allAreas = [] } = useQuery<Area[]>({
    queryKey: ['areas'],
    queryFn:  () => apiFetch<Area[]>('/api/contacts/areas'),
  })

  // When type filter is active, only show areas of that type in the picker
  const pickerAreas = typeFilter
    ? allAreas.filter((a) => a.contactType === typeFilter)
    : allAreas

  // If a specific area is selected but type filter no longer includes it, clear area
  const effectiveAreaFilter = (typeFilter && areaFilter)
    ? (pickerAreas.some((a) => a.id === areaFilter) ? areaFilter : '')
    : areaFilter

  const params = new URLSearchParams({ page: String(page), limit: '50' })
  if (statusFilter === 'invalid')   params.set('phoneValid', 'false')
  if (statusFilter === 'valid')     { params.set('phoneValid', 'true'); params.set('waChecked', 'true') }
  if (statusFilter === 'unchecked') { params.set('phoneValid', 'true'); params.set('waChecked', 'false') }
  if (typeFilter)                   params.set('contactType', typeFilter)
  if (effectiveAreaFilter)          params.set('areaId', effectiveAreaFilter)

  const { data, isLoading } = useQuery<ContactsPage>({
    queryKey: ['contacts', page, statusFilter, typeFilter, effectiveAreaFilter],
    queryFn:  () => apiFetch<ContactsPage>(`/api/contacts?${params}`),
  })

  // Poll validation queue status — shows progress + enables cancel button
  const { data: queueStatus } = useQuery<{ waiting: number; active: number; total: number }>({
    queryKey: ['validate-wa-status'],
    queryFn:  () => apiFetch<{ waiting: number; active: number; total: number }>('/api/contacts/validate-wa/status'),
    refetchInterval: (query) => {
      const d = query.state.data
      return (d && d.total > 0) ? 2000 : 10000 // poll faster when jobs are running
    },
  })

  const queueActive = (queueStatus?.total ?? 0) > 0

  const validateMutation = useMutation({
    mutationFn: ({ recheck, limitPerArea, areaIds }: { recheck: boolean; limitPerArea?: number | null; areaIds?: string[] }) =>
      apiFetch<{ queued: number }>('/api/contacts/validate-wa', {
        method: 'POST',
        body: JSON.stringify({
          recheck,
          ...(limitPerArea != null ? { limitPerArea } : {}),
          ...(areaIds && areaIds.length > 0 ? { areaIds } : {}),
        }),
      }),
    onSuccess: (result, { recheck }) => {
      if (result.queued === 0) {
        setValidateMsg('Tidak ada nomor yang perlu dicek.')
      } else {
        setValidateMsg(
          `${result.queued} nomor diantrekan untuk dicek${recheck ? ' (ulang)' : ''}. Status akan diperbarui otomatis.`
        )
        queryClient.invalidateQueries({ queryKey: ['contacts'] })
        queryClient.invalidateQueries({ queryKey: ['validate-wa-status'] })
        setTimeout(() => queryClient.invalidateQueries({ queryKey: ['contacts'] }), 3000)
      }
    },
  })

  const cancelMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ cancelled: number }>('/api/contacts/validate-wa/cancel', { method: 'POST' }),
    onSuccess: (result) => {
      setValidateMsg(`Validasi dibatalkan. ${result.cancelled} job dihapus dari antrian.`)
      queryClient.invalidateQueries({ queryKey: ['contacts'] })
      queryClient.invalidateQueries({ queryKey: ['validate-wa-status'] })
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
          {/* Tipe filter */}
          <select
            value={typeFilter}
            onChange={(e) => { setTypeFilter(e.target.value); setAreaFilter(''); setPage(1) }}
            className="text-sm border rounded-md px-3 py-1.5 bg-background"
          >
            <option value="">Semua Tipe</option>
            <option value="STIK">STIK</option>
            <option value="KARDUS">KARDUS</option>
          </select>

          {/* Area searchable combobox */}
          <AreaPicker
            value={effectiveAreaFilter}
            onChange={(id) => { setAreaFilter(id); setPage(1) }}
            areas={pickerAreas}
          />

          {/* Status filter */}
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
            onClick={() => setValidasiModal(true)}
            disabled={validateMutation.isPending}
            title="Cek nomor yang belum pernah divalidasi"
            className="text-sm border rounded-md px-3 py-1.5 bg-background disabled:opacity-50 hover:bg-accent transition-colors"
          >
            {validateMutation.isPending ? 'Mengantrekan...' : 'Validasi WA'}
          </button>
          <button
            type="button"
            onClick={() => validateMutation.mutate({ recheck: true })}
            disabled={validateMutation.isPending}
            title="Cek ulang semua nomor termasuk yang sudah divalidasi"
            className="text-sm border rounded-md px-3 py-1.5 bg-background disabled:opacity-50 hover:bg-accent transition-colors"
          >
            Cek Ulang Semua
          </button>
          {queueActive && (
            <button
              type="button"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
              title="Batalkan semua validasi yang menunggu dalam antrian"
              className="text-sm border border-red-200 rounded-md px-3 py-1.5 bg-red-50 text-red-600 disabled:opacity-50 hover:bg-red-100 transition-colors"
            >
              {cancelMutation.isPending ? 'Membatalkan...' : `Batalkan (${queueStatus?.waiting ?? 0} antrian)`}
            </button>
          )}
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

      <ValidasiModal
        open={validasiModalOpen}
        onClose={() => setValidasiModal(false)}
        onConfirm={(areaIds, limitPerArea) => {
          setValidasiModal(false)
          validateMutation.mutate({ recheck: false, limitPerArea, areaIds })
        }}
      />
    </div>
  )
}
