import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/utils'

interface ValidasiModalProps {
  open:      boolean
  onClose:   () => void
  /** Called with the chosen limit (null = validate all unchecked) */
  onConfirm: (limit: number | null) => void
}

export default function ValidasiModal({ open, onClose, onConfirm }: ValidasiModalProps) {
  const [inputValue, setInputValue] = useState('')

  const { data, isLoading } = useQuery<{ unchecked: number }>({
    queryKey: ['validate-wa-count'],
    queryFn:  () => apiFetch<{ unchecked: number }>('/api/contacts/validate-wa/count'),
    enabled:  open,
    // Re-fetch every time the modal opens (staleTime 0 ensures fresh data)
    staleTime: 0,
  })

  const unchecked = data?.unchecked ?? 0

  // Pre-fill input when count loads (or modal opens)
  useEffect(() => {
    if (open && !isLoading && data !== undefined) {
      setInputValue(String(unchecked))
    }
  }, [open, isLoading, data, unchecked])

  // Reset input when modal closes
  useEffect(() => {
    if (!open) setInputValue('')
  }, [open])

  if (!open) return null

  const parsed   = parseInt(inputValue, 10)
  const isValid  = !Number.isNaN(parsed) && parsed > 0
  const isAll    = isValid && parsed >= unchecked

  function handleConfirm() {
    if (!isValid) return
    onConfirm(isAll ? null : parsed)
  }

  function handleValidasiSemua() {
    setInputValue(String(unchecked))
  }

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
      <div className="relative bg-background rounded-lg shadow-lg border w-full max-w-sm mx-4 p-6 space-y-4">
        <h3 className="font-semibold text-base">Validasi WA</h3>

        <div className="space-y-3">
          <label htmlFor="validasi-limit" className="block text-sm text-muted-foreground">
            Berapa nomor yang ingin divalidasi?
          </label>

          <input
            id="validasi-limit"
            type="number"
            min={1}
            max={unchecked}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            disabled={isLoading || unchecked === 0}
            className="w-full text-sm rounded-md border px-3 py-2 bg-background disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-ring"
            ref={(el) => { if (el && open) el.focus() }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm() }}
          />

          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            {isLoading ? (
              <span>Menghitung nomor belum dicek…</span>
            ) : unchecked === 0 ? (
              <span className="text-green-700 font-medium">Semua nomor sudah dicek</span>
            ) : (
              <>
                <span>
                  {unchecked.toLocaleString('id-ID')} nomor belum dicek
                </span>
                <span className="text-muted-foreground/40">·</span>
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={handleValidasiSemua}
                >
                  Validasi Semua
                </button>
              </>
            )}
          </div>
        </div>

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
            disabled={!isValid || isLoading || unchecked === 0}
            className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md disabled:opacity-50 transition-colors"
          >
            Mulai Validasi
          </button>
        </div>
      </div>
    </div>
  )
}
