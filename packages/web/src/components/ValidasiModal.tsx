import { useState, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/utils'

interface AreaInfo {
  areaId:      string
  name:        string
  contactType: string
  unchecked:   number
  validated:   number
  registered:  number
  invalid:     number
  total:       number
}

interface CountData {
  unchecked: number
  areaCount: number
  areas:     AreaInfo[]
}

interface ValidasiModalProps {
  open:      boolean
  onClose:   () => void
  /** Called with normal areaIds, recheckAreaIds (fully validated areas), and limitPerArea */
  onConfirm: (areaIds: string[], recheckAreaIds: string[], limitPerArea: number | null) => void
}

export default function ValidasiModal({ open, onClose, onConfirm }: ValidasiModalProps) {
  const [inputValue, setInputValue]     = useState('60')
  const [noLimit, setNoLimit]           = useState(false)
  const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set())
  const [search, setSearch]             = useState('')

  const { data, isLoading } = useQuery<CountData>({
    queryKey: ['validate-wa-count'],
    queryFn:  () => apiFetch<CountData>('/api/contacts/validate-wa/count'),
    enabled:  open,
    staleTime: 0,
  })

  const unchecked = data?.unchecked ?? 0
  const areas     = data?.areas ?? []

  // Group areas by contactType
  const stikAreas   = useMemo(() => areas.filter((a) => a.contactType === 'STIK'), [areas])
  const kardusAreas = useMemo(() => areas.filter((a) => a.contactType === 'KARDUS'), [areas])

  // Filter by search
  const filteredStik   = useMemo(() =>
    search ? stikAreas.filter((a) => a.name.toLowerCase().includes(search.toLowerCase())) : stikAreas,
    [stikAreas, search],
  )
  const filteredKardus = useMemo(() =>
    search ? kardusAreas.filter((a) => a.name.toLowerCase().includes(search.toLowerCase())) : kardusAreas,
    [kardusAreas, search],
  )

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setInputValue('60')
      setNoLimit(false)
      setSelectedIds(new Set())
      setSearch('')
    }
  }, [open])

  // Auto-select only areas that have NEVER been validated (validated === 0).
  // Areas that have any validated phones (even partially) start unchecked —
  // the user can opt-in to validate remaining or re-check them.
  const selectedCount = selectedIds.size
  useEffect(() => {
    if (data?.areas && data.areas.length > 0 && selectedCount === 0) {
      setSelectedIds(new Set(data.areas.filter((a) => a.validated === 0 && a.unchecked > 0).map((a) => a.areaId)))
    }
  }, [data, selectedCount])

  if (!open) return null

  const parsed     = parseInt(inputValue, 10)
  const limitValid = noLimit || (!Number.isNaN(parsed) && parsed > 0)
  const hasSelection = selectedIds.size > 0
  const isValid    = limitValid && hasSelection

  // Compute total contacts that will be queued
  // For areas with unchecked > 0: queue min(unchecked, limitPerArea)
  // For areas with unchecked === 0 (recheck): queue min(total, limitPerArea)
  const totalToQueue = areas
    .filter((a) => selectedIds.has(a.areaId))
    .reduce((sum, a) => {
      const count = a.unchecked > 0 ? a.unchecked : a.total
      return sum + (noLimit ? count : Math.min(count, parsed || 0))
    }, 0)

  function toggleArea(areaId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(areaId)) next.delete(areaId)
      else next.add(areaId)
      return next
    })
  }

  function toggleGroup(groupAreas: AreaInfo[]) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      const allSelected = groupAreas.every((a) => prev.has(a.areaId))
      for (const a of groupAreas) {
        if (allSelected) next.delete(a.areaId)
        else next.add(a.areaId)
      }
      return next
    })
  }

  function handleConfirm() {
    if (!isValid) return
    // Split selected areas into normal (unchecked > 0) and recheck (unchecked === 0)
    const normalIds:  string[] = []
    const recheckIds: string[] = []
    for (const id of selectedIds) {
      const area = areas.find((a) => a.areaId === id)
      if (!area) continue
      if (area.unchecked > 0) normalIds.push(id)
      else recheckIds.push(id)
    }
    onConfirm(normalIds, recheckIds, noLimit ? null : parsed)
  }

  function renderGroup(label: string, groupAreas: AreaInfo[], filtered: AreaInfo[]) {
    if (groupAreas.length === 0) return null
    const allSelected   = groupAreas.length > 0 && groupAreas.every((a) => selectedIds.has(a.areaId))

    return (
      <div className="space-y-1">
        {/* Group header */}
        <div className="flex items-center justify-between border-b pb-1">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</span>
          <button
            type="button"
            onClick={() => toggleGroup(groupAreas)}
            className="text-xs text-primary hover:underline"
          >
            {allSelected ? 'Hapus Semua' : 'Pilih Semua'}
          </button>
        </div>

        {/* Area checkboxes */}
        {filtered.map((area) => {
          const hasValidated = area.validated > 0
          return (
            <label
              key={area.areaId}
              className={`flex items-center gap-2 py-0.5 cursor-pointer select-none ${hasValidated ? 'opacity-60' : ''}`}
            >
              <input
                type="checkbox"
                checked={selectedIds.has(area.areaId)}
                onChange={() => toggleArea(area.areaId)}
                className="rounded border-gray-300 text-primary focus:ring-primary"
              />
              <span className="text-sm flex-1 truncate">{area.name}</span>
              {hasValidated ? (
                <span className="flex flex-col items-end text-xs tabular-nums leading-tight">
                  <span className="flex items-center gap-1 text-green-600 whitespace-nowrap">
                    <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" role="img">
                      <title>Validated</title>
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    {area.validated.toLocaleString('id-ID')} dicek
                    {area.unchecked > 0 && (
                      <span className="text-muted-foreground">&middot; {area.unchecked.toLocaleString('id-ID')} belum</span>
                    )}
                  </span>
                  <span className="text-muted-foreground whitespace-nowrap">
                    {area.registered.toLocaleString('id-ID')} terdaftar / {area.invalid.toLocaleString('id-ID')} tidak valid
                  </span>
                </span>
              ) : (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {area.unchecked.toLocaleString('id-ID')}
                </span>
              )}
            </label>
          )
        })}

        {/* No results for search */}
        {filtered.length === 0 && search && (
          <p className="text-xs text-muted-foreground italic pl-5">Tidak ditemukan</p>
        )}
      </div>
    )
  }

  // Count how many selected areas are recheck vs normal
  const selectedNormalCount  = areas.filter((a) => selectedIds.has(a.areaId) && a.unchecked > 0).length
  const selectedRecheckCount = areas.filter((a) => selectedIds.has(a.areaId) && a.unchecked === 0).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-background rounded-lg shadow-lg border w-full max-w-md mx-4 p-6 space-y-4 max-h-[85vh] flex flex-col">
        <h3 className="font-semibold text-base">Validasi WA</h3>

        {/* Limit per area input */}
        <div className="space-y-2">
          <label htmlFor="validasi-limit" className="block text-sm text-muted-foreground">
            Limit per area
          </label>
          <input
            id="validasi-limit"
            type="number"
            min={1}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            disabled={isLoading || noLimit}
            className="w-full text-sm rounded-md border px-3 py-2 bg-background disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-ring"
            onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm() }}
          />
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={noLimit}
              onChange={(e) => setNoLimit(e.target.checked)}
              disabled={isLoading}
              className="rounded border-gray-300 text-primary focus:ring-primary"
            />
            <span className="text-sm">Tanpa limit per area</span>
          </label>
        </div>

        {/* Area selection */}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Memuat data area...</p>
        ) : areas.length === 0 ? (
          <p className="text-sm text-muted-foreground">Tidak ada area dengan kontak.</p>
        ) : (
          <>
            {/* Search */}
            <input
              type="text"
              placeholder="Cari area..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full text-sm rounded-md border px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />

            {/* Scrollable area list */}
            <div className="overflow-y-auto flex-1 min-h-0 max-h-[40vh] space-y-4 pr-1">
              {renderGroup('STIK', stikAreas, filteredStik)}
              {renderGroup('KARDUS', kardusAreas, filteredKardus)}
            </div>

            {/* Summary */}
            <div className="text-xs text-muted-foreground border-t pt-2 space-y-0.5">
              {hasSelection ? (
                <>
                  <span>
                    Total: <strong>{totalToQueue.toLocaleString('id-ID')}</strong> nomor dari{' '}
                    <strong>{selectedIds.size}</strong> area
                  </span>
                  {selectedRecheckCount > 0 && (
                    <p className="text-green-600">
                      {selectedRecheckCount} area akan dicek ulang
                    </p>
                  )}
                </>
              ) : (
                <span>Pilih minimal satu area untuk memulai validasi</span>
              )}
            </div>
          </>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="border text-sm px-4 py-2 rounded-md hover:bg-accent transition-colors"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!isValid || isLoading}
            className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md disabled:opacity-50 transition-colors"
          >
            Mulai Validasi
          </button>
        </div>
      </div>
    </div>
  )
}
