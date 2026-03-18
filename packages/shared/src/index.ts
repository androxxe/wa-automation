// ─── Contact / Campaign types ─────────────────────────────────────────────────

export type ContactType  = 'STIK' | 'KARDUS'
export type CampaignType = 'STIK' | 'KARDUS'

// ─── Campaign ─────────────────────────────────────────────────────────────────

export type CampaignStatus =
  | 'DRAFT'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'CANCELLED'

// ─── Message ──────────────────────────────────────────────────────────────────

export type MessageStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED'
  | 'CANCELLED'

// ─── Agent ────────────────────────────────────────────────────────────────────

export type AgentStatus = 'OFFLINE' | 'STARTING' | 'ONLINE' | 'QR' | 'ERROR'

export interface AgentInfo {
  id: number              // integer autoincrement — e.g. 1, 2, 3
  name: string
  profilePath: string
  status: AgentStatus
  departmentId: string | null
  departmentName: string | null
  activeJobCount: number
  sentToday: number
  screenshot: string | null  // base64 jpeg, null when offline
  warmMode: boolean
  isWarmed: boolean
  warmedAt: string | null
}

// ─── Queue job payloads ───────────────────────────────────────────────────────

export interface MessageJob {
  messageId: string
  campaignId: string
  contactId: string
  phone: string      // +62...
  body: string       // rendered template (pre-variation)
  agentId?: number   // preferred agent (int) — falls back to pool if offline
}

export interface PhoneCheckJob {
  phone: string       // +62...
  contactId?: string  // kept for logging; worker uses updateMany by phoneNorm
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

export type ReplyCategory  = 'confirmed' | 'denied' | 'question' | 'unclear' | 'other'
export type ReplySentiment = 'positive' | 'neutral' | 'negative'

export interface ReplyAnalysis {
  category:  ReplyCategory
  sentiment: ReplySentiment
  summary:   string
  jawaban:   1 | 0 | null
}

// ─── Browser / Agent status ───────────────────────────────────────────────────

export type BrowserStatus = 'connected' | 'qr' | 'loading' | 'disconnected'

export interface BrowserStatusPayload {
  status:     BrowserStatus
  qrDataUrl?: string
}

// ─── SSE event shapes ─────────────────────────────────────────────────────────

export type SseEventType =
  | 'agent:status'
  | 'agent:screenshot'
  | 'browser:status'        // kept for backward compat (single-agent)
  | 'message:sent'
  | 'message:delivered'
  | 'message:read'
  | 'message:failed'
  | 'message:cancelled'
  | 'reply:received'
  | 'campaign:progress'
  | 'campaign:area_target_reached'
  | 'campaign:break'
  | 'campaign:completed'
  | 'daily:cap'

export interface SseEvent<T = unknown> {
  type:    SseEventType
  payload: T
}

// ─── API response wrappers ────────────────────────────────────────────────────

export interface ApiOk<T> {
  ok:   true
  data: T
}

export interface ApiError {
  ok:       false
  error:    string
  details?: unknown
}

export type ApiResponse<T> = ApiOk<T> | ApiError

// ─── File scan tree ───────────────────────────────────────────────────────────

export interface AreaFile {
  name:        string  // "Aceh Barat"
  fileName:    string  // "Aceh Barat.xlsx"
  filePath:    string
  contactType: ContactType
}

export interface DepartmentTree {
  name:  string    // "Department 1"
  path:  string
  areas: AreaFile[]
}

export interface ContactTypeTree {
  contactType: ContactType
  departments: DepartmentTree[]
}

// ─── Excel parse result ───────────────────────────────────────────────────────

export interface ParsedSheet {
  headers:    string[]
  sampleRows: Record<string, unknown>[]
  totalRows:  number
}

// ─── Import result ────────────────────────────────────────────────────────────

export interface ImportResult {
  imported:   number
  invalid:    number
  duplicates: number
}

// ─── Campaign progress ────────────────────────────────────────────────────────

export interface CampaignProgress {
  campaignId:     string
  totalCount:     number
  sentCount:      number
  deliveredCount: number
  readCount:      number
  failedCount:    number
  replyCount:     number
  cancelledCount: number
}

// ─── Per-area enqueue preview ─────────────────────────────────────────────────

export interface AreaEnqueuePreview {
  areaId:       string
  areaName:     string
  totalInArea:  number  // all contacts in this area regardless of type/status
  wrongType:    number  // contacts with a different contactType
  notValidated: number  // correct type, valid phone, but waChecked=false
  invalidPhone: number  // correct type, phoneValid=false
  available:    number  // ready to send: correct type + phoneValid + waChecked
  willSend:     number  // min(sendLimit, available)
  target:       number  // targetRepliesPerArea
  warning?:     string  // human-readable explanation of any limiting factor
}

// ─── Warmer ───────────────────────────────────────────────────────────────────

export interface WarmJob {
  warmSessionId:    string
  exchangeId:       string
  senderAgentId:    number
  recipientAgentId: number
  senderPhone:      string
  recipientPhone:   string
  message:          string
  replyMessage:     string
  isReply:          boolean
}

export type WarmSessionStatus  = 'IDLE' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED'
export type WarmExchangeStatus = 'PENDING' | 'SENT' | 'REPLIED' | 'FAILED'

export interface WarmSessionInfo {
  id:             string
  name:           string
  status:         WarmSessionStatus
  totalExchanges: number
  doneExchanges:  number
  partialFailure: boolean
  createdAt:      string
  startedAt:      string | null
  completedAt:    string | null
  agents:         Array<{ agentId: number; agentName: string; phoneNumber: string }>
}

export interface WarmExchangeInfo {
  id:               string
  warmSessionId:    string
  senderAgentId:    number
  recipientAgentId: number
  message:          string
  replyMessage:     string
  status:           WarmExchangeStatus
  sentAt:           string | null
  repliedAt:        string | null
  failReason:       string | null
  createdAt:        string
}

// ─── AppConfig ────────────────────────────────────────────────────────────────

export interface AppConfigData {
  defaultTargetRepliesPerArea: number
  defaultExpectedReplyRate:    number
  defaultSendPerArea:          number  // computed: ceil(target / rate)
  // Agent defaults — read-only from env vars
  defaultDailySendCap: number
  defaultBreakEvery:  number
  defaultBreakMinSec: number  // seconds
  defaultBreakMaxSec: number  // seconds
  // Agent typing speed defaults — read-only from env vars
  defaultTypeDelayMin: number  // ms per keystroke
  defaultTypeDelayMax: number  // ms per keystroke
}
