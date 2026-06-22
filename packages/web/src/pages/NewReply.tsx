import { useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/utils'

interface UnrepliedPhone {
  phone: string
  campaignId: string
  campaignName: string
  areaName: string
  messageBody: string
  sentAt: string | null
}

const CATEGORIES = ['confirmed', 'denied', 'question', 'unclear', 'invalid', 'other'] as const
const JAWABAN_OPTIONS = [
  { value: 1, label: 'Ya' },
  { value: 0, label: 'Tidak' },
] as const

export default function NewReply() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)

  const [phone, setPhone] = useState('')
  const [body, setBody] = useState('')
  const [jawaban, setJawaban] = useState<number>(1)
  const [category, setCategory] = useState<string>('')
  const [photoBase64, setPhotoBase64] = useState('')
  const [photoName, setPhotoName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [lookupResult, setLookupResult] = useState<UnrepliedPhone | null>(null)
  const [lookupPending, setLookupPending] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)

  const lookupPhone = useCallback(async (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) { setLookupResult(null); setLookupError(null); return }
    setLookupPending(true)
    setLookupError(null)
    try {
      const res = await apiFetch<UnrepliedPhone[]>(`/api/replies/unreplied-phones?phone=${encodeURIComponent(trimmed)}`)
      if (res.length > 0) {
        setLookupResult(res[0])
      } else {
        setLookupResult(null)
        setLookupError('No unreplied message found for this phone')
      }
    } catch (e) {
      setLookupResult(null)
      setLookupError(String(e))
    } finally {
      setLookupPending(false)
    }
  }, [])

  const selectedPhone = lookupResult

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiFetch<{ created: string[]; count: number }>('/api/replies', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['replies'] })
      setError(null)
      if (data.count > 0) {
        setSuccess(`Reply recorded for ${selectedPhone?.campaignName ?? phone} (${data.count} message(s))`)
        setPhone('')
        setBody('')
        setCategory('')
        setPhotoBase64('')
        setPhotoName('')
        setLookupResult(null)
        setLookupError(null)
        setJawaban(1)
        if (fileRef.current) fileRef.current.value = ''
      } else {
        setError('No replies created — message may already have a reply')
      }
    },
    onError: (e) => setError(String(e)),
  })

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setPhotoName(file.name)
    const reader = new FileReader()
    reader.onload = () => setPhotoBase64(reader.result as string)
    reader.readAsDataURL(file)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!phone || !body || !category || !photoBase64) {
      setError('All fields are required')
      return
    }
    setError(null)
    createMutation.mutate({
      phone,
      body,
      source: 'manual',
      jawaban,
      category,
      photo: photoBase64,
    })
  }

  return (
    <div className="max-w-lg mx-auto py-8 px-4">
      <h2 className="text-lg font-semibold mb-6">New Reply</h2>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Success */}
        {success && (
          <div className="rounded-md bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-700 flex items-center justify-between">
            <span>{success}</span>
            <button type="button" onClick={() => setSuccess(null)} className="text-green-500 hover:text-green-700 text-lg leading-none">&times;</button>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Phone input */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">
            Phone <span className="text-destructive">*</span>
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={phone}
              onChange={(e) => { setPhone(e.target.value); setLookupResult(null); setLookupError(null); setSuccess(null) }}
              onBlur={() => lookupPhone(phone)}
              placeholder="+6289673681925"
              className="flex-1 border rounded-md px-3 py-2 text-sm bg-background font-mono"
              required
            />
            <button
              type="button"
              onClick={() => lookupPhone(phone)}
              disabled={lookupPending}
              className="text-sm px-3 py-2 rounded-md border hover:bg-accent disabled:opacity-50"
            >
              {lookupPending ? '…' : 'Lookup'}
            </button>
          </div>
          {lookupError && (
            <p className="text-xs text-destructive">{lookupError}</p>
          )}
          {selectedPhone && !lookupPending && (
            <p className="text-xs text-muted-foreground">
              Campaign: {selectedPhone.campaignName} · Area:{' '}
              {selectedPhone.areaName} · Sent:{' '}
              {selectedPhone.sentAt
                ? new Date(selectedPhone.sentAt).toLocaleString()
                : '-'}
            </p>
          )}
        </div>

        {/* Campaign (readonly) */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-muted-foreground">Campaign</label>
          <input
            type="text"
            value={selectedPhone?.campaignName ?? ''}
            readOnly
            className="w-full border rounded-md px-3 py-2 text-sm bg-muted/50 text-muted-foreground"
          />
        </div>

        {/* Reply text */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">
            Reply Text <span className="text-destructive">*</span>
          </label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            className="w-full border rounded-md px-3 py-2 text-sm bg-background resize-y"
            placeholder="Type the reply message from WhatsApp…"
            required
          />
        </div>

        {/* Jawaban + Category row */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              Jawaban <span className="text-destructive">*</span>
            </label>
            <select
              value={jawaban}
              onChange={(e) => setJawaban(Number(e.target.value))}
              className="w-full border rounded-md px-3 py-2 text-sm bg-background"
            >
              {JAWABAN_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              Category <span className="text-destructive">*</span>
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full border rounded-md px-3 py-2 text-sm bg-background"
              required
            >
              <option value="" disabled>
                Select…
              </option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Photo upload */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">
            Proof Photo <span className="text-destructive">*</span>
          </label>
          <p className="text-xs text-muted-foreground">
            Screenshot WhatsApp dari HP yang menunjukkan balasan
          </p>
          <div className="flex items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-primary file:text-primary-foreground"
            />
            {photoName && (
              <span className="text-sm text-muted-foreground truncate max-w-[200px]">
                {photoName}
              </span>
            )}
          </div>
          {photoBase64 && (
            <img
              src={photoBase64}
              alt="Preview"
              className="mt-2 rounded-md border max-h-40 object-contain"
            />
          )}
        </div>

        {/* Submit */}
        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={createMutation.isPending}
            className="bg-primary text-primary-foreground text-sm px-5 py-2 rounded-md disabled:opacity-50"
          >
            {createMutation.isPending ? 'Submitting…' : 'Submit Reply'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/responses')}
            className="text-sm px-5 py-2 rounded-md border"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
