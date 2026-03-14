// ─── Campaign ───────────────────────────────────────────────────────────────

export type CampaignStatus =
  | 'DRAFT'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'CANCELLED'

// ─── Message ─────────────────────────────────────────────────────────────────

export type MessageStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED'

// ─── Queue job payload ────────────────────────────────────────────────────────

export interface MessageJob {
  messageId: string
  campaignId: string
  contactId: string
  phone: string   // +62...
  body: string    // rendered template (pre-variation)
}

export interface PhoneCheckJob {
  phone: string       // +62...
  contactId?: string  // if provided, worker updates contact.phoneValid
}

export interface PhoneCheckResult {
  phone: string
  registered: boolean
}

// ─── Claude response shapes ───────────────────────────────────────────────────

export interface ColumnMapping {
  phone: string | null
  store_name: string | null
  seq_no: string | null
  freezer_id: string | null
  exchange_count: string | null
  award_count: string | null
  total_count: string | null
}

export type ReplyCategory = 'confirmed' | 'denied' | 'question' | 'unclear' | 'other'
export type ReplySentiment = 'positive' | 'neutral' | 'negative'

export interface ReplyAnalysis {
  category: ReplyCategory
  sentiment: ReplySentiment
  summary: string
  jawaban: 1 | 0 | null  // AI-determined binary answer: 1=Ya, 0=Tidak, null=unclear
}

// ─── Browser status ───────────────────────────────────────────────────────────

export type BrowserStatus = 'connected' | 'qr' | 'loading' | 'disconnected'

export interface BrowserStatusPayload {
  status: BrowserStatus
  qrDataUrl?: string   // base64 data URL when status === 'qr'
}

// ─── SSE event shapes ─────────────────────────────────────────────────────────

export type SseEventType =
  | 'browser:status'
  | 'message:sent'
  | 'message:delivered'
  | 'message:read'
  | 'message:failed'
  | 'reply:received'
  | 'campaign:progress'
  | 'campaign:break'
  | 'campaign:completed'
  | 'daily:cap'

export interface SseEvent<T = unknown> {
  type: SseEventType
  payload: T
}

// ─── API response wrappers ────────────────────────────────────────────────────

export interface ApiOk<T> {
  ok: true
  data: T
}

export interface ApiError {
  ok: false
  error: string
  details?: unknown
}

export type ApiResponse<T> = ApiOk<T> | ApiError

// ─── File scan tree ───────────────────────────────────────────────────────────

export interface AreaFile {
  name: string       // "Aceh Barat"
  fileName: string   // "Aceh Barat.xlsx"
  filePath: string
}

export interface DepartmentTree {
  name: string       // "Department 1"
  path: string
  areas: AreaFile[]
}

// ─── Excel parse result ───────────────────────────────────────────────────────

export interface ParsedSheet {
  headers: string[]
  sampleRows: Record<string, unknown>[]
  totalRows: number
}

// ─── Import result ────────────────────────────────────────────────────────────

export interface ImportResult {
  imported: number
  invalid: number
  duplicates: number
}

// ─── Campaign progress ────────────────────────────────────────────────────────

export interface CampaignProgress {
  campaignId: string
  totalCount: number
  sentCount: number
  deliveredCount: number
  readCount: number
  failedCount: number
  replyCount: number
}
