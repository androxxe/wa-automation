import type { ColumnMapping, ReplyAnalysis } from "@aice/shared"
import { randomUUID } from "node:crypto"

const MODEL = process.env.OPCODE_MODEL ?? "deepseek-v4-flash"
// Muse Spark speaks only the OpenAI Responses API — chat completions returns
// 400 ModelProtocolUnsupported. Everything else stays on chat completions.
const USE_RESPONSES_API = /^muse-spark/.test(MODEL)
const REASONING_EFFORT = process.env.OPCODE_REASONING_EFFORT ?? "low"
const BASE_URL = "https://opencode.ai/zen/go/v1"
// Stable per-process session id — required by OpenCode Go routing
// (400 MissingSessionID without it). Override via OPCODE_SESSION_ID if needed.
const SESSION_ID = process.env.OPCODE_SESSION_ID ?? `aice-api-${randomUUID()}`
const USER_AGENT = "aice-whatsapp-automation/1.0"

if (!process.env.OPCODE_API_KEY) throw new Error("OPCODE_API_KEY is not set")

function parseJsonFrom(text: string, context: string): unknown {
  const json = text.match(/\{[\s\S]*\}/)?.[0]
  if (!json) throw new Error(`${context} did not return valid JSON`)
  return JSON.parse(json)
}

function handleApiError(err: unknown, context: string): never {
  const status = (err as { status?: number }).status
  const message = (err as { message?: string }).message ?? "Unknown error"
  console.log({ status, message })
  let friendly: string
  switch (status) {
    case 400:
      friendly = `OpenCode API error (400): ${message}`
      break
    case 401:
      friendly = "OpenCode API error (401): Invalid API key"
      break
    case 429:
      friendly =
        "OpenCode API error (429): Rate limit exceeded or quota exhausted"
      break
    case 500:
      friendly = "OpenCode API error (500): Internal server error"
      break
    default:
      friendly = `OpenCode API error (${status ?? "unknown"}): ${message}`
  }

  console.error(`[opencode] ${context}:`, friendly)
  throw new Error(friendly)
}

// ─── Protocol helpers (chat completions vs Responses API) ────────────────────

interface ApiBody {
  choices?: { message?: { content?: string } }[]
  status?: string
  incomplete_details?: { reason?: string }
  output?: { type?: string; content?: { type?: string; text?: string }[] }[]
  error?: { message?: string; code?: string; type?: string }
}

function apiUrl(): string {
  return `${BASE_URL}${USE_RESPONSES_API ? '/responses' : '/chat/completions'}`
}

function apiHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.OPCODE_API_KEY}`,
    'x-opencode-session': SESSION_ID,
    'User-Agent': USER_AGENT,
  }
}

function buildRequestBody(
  systemPrompt: string,
  input: unknown,
  maxTokens: number,
  temperature: number,
): string {
  if (USE_RESPONSES_API) {
    return JSON.stringify({
      model: MODEL,
      max_output_tokens: maxTokens,
      temperature,
      reasoning: { effort: REASONING_EFFORT },
      instructions: systemPrompt,
      input: [{ role: 'user', content: input }],
    })
  }
  return JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input },
    ],
  })
}

function extractText(body: ApiBody): string | undefined {
  if (!USE_RESPONSES_API) return body.choices?.[0]?.message?.content
  const text = (body.output ?? [])
    .filter((o) => o.type === 'message')
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text ?? '')
    .join('')
  return text || undefined
}

function apiError(body: ApiBody): Error {
  return new Error(body.error?.message ?? JSON.stringify(body).slice(0, 500))
}

async function runChat(
  prompt: string,
  opts: { maxTokens: number; temperature: number },
): Promise<string> {
  const system = 'You are a precise assistant. Output only the exact requested JSON. Do not include any reasoning, explanation, code blocks, or markdown formatting in your response.'
  try {
    const res = await fetch(apiUrl(), {
      method: 'POST',
      headers: apiHeaders(),
      body: buildRequestBody(system, prompt, opts.maxTokens, opts.temperature),
    })

    const body = await res.json() as ApiBody
    console.error('[opencode] raw response:', JSON.stringify(body).slice(0, 1000))

    if (!res.ok) {
      throw Object.assign(apiError(body), { status: res.status })
    }
    if (body.status === 'incomplete') {
      console.error('[opencode] incomplete response:', body.incomplete_details?.reason)
    }

    const text = extractText(body)
    if (!text) {
      console.error('[opencode] empty content — full response:', JSON.stringify(body).slice(0, 2000))
      throw new Error('OpenCode returned empty response')
    }
    return text
  } catch (err: unknown) {
    handleApiError(err, 'runChat')
  }
}

// ─── Vision API (image → text + analysis) ──────────────────────────────────────

interface ImageExtractionResult {
  phone:    string
  text:     string
  category: string
  sentiment: string
  summary:  string
  jawaban:  number | null
}

async function runImageChat(
  systemPrompt: string,
  userText: string,
  photoBase64: string,
  mimeType: string,
): Promise<string> {
  const dataUrl = `data:${mimeType};base64,${photoBase64}`
  const userContent = USE_RESPONSES_API
    ? [
        { type: 'input_text', text: userText },
        { type: 'input_image', image_url: dataUrl },
      ]
    : [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: dataUrl } },
      ]

  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(apiUrl(), {
        method: 'POST',
        headers: apiHeaders(),
        body: buildRequestBody(systemPrompt, userContent, 8192, 0),
      })

      const body = await res.json() as ApiBody
      console.error('[opencode] image response:', JSON.stringify(body).slice(0, 1000))

      if (!res.ok) {
        const code = body.error?.code ?? body.error?.type
        const status = code === 'rate_limit_exceeded' ? 429 : res.status
        throw Object.assign(apiError(body), { status })
      }

      const text = extractText(body)
      if (!text) {
        console.error('[opencode] empty image content — full response:', JSON.stringify(body).slice(0, 2000))
        throw new Error('OpenCode returned empty response for image')
      }
      return text
    } catch (err: unknown) {
      lastErr = err
      const status = (err as { status?: number }).status
      if ((status === 429 || (status && status >= 500 && status < 600)) && attempt < 2) {
        const delay = attempt === 0 ? 5000 : 15000
        console.warn(`[opencode] image attempt ${attempt + 1} got ${status}, retrying in ${delay / 1000}s…`)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      break
    }
  }
  return handleApiError(lastErr, 'runImageChat')
}

export async function extractReplyFromImage(
  photoBase64: string,
  mimeType: string,
): Promise<ImageExtractionResult> {
  const system = 'You are a precise assistant. Extract information from the WhatsApp chat screenshot. Output only the exact requested JSON. Do not include any reasoning, explanation, code blocks, or markdown formatting.'

  const user = `This is a WhatsApp chat screenshot from a shop owner replying to a campaign message. The longer multi-line message is the campaign question. We need the SHORT REPLY from the shop owner (usually a short response like "yaa", "sudah", "belum", "tidak", "oke", etc.).

1. Phone number — look for "+62..." or "08..." in the chat header
2. Reply text — the SHORT reply message from the shop owner, NOT the long campaign question. Only extract text, skip emojis and images
3. Classify the reply based on what the campaign question asks about:
   - "confirmed" if they say yes/iya/betul/sudah/ada/oke/siap
   - "denied" if they say no/tidak/belum/ngga/gak/blm/ndak
   - "question" if they ask a question
   - "unclear" if ambiguous
   - "other" if off-topic
4. Sentiment: "positive" | "neutral" | "negative"
5. Summary: one short sentence in Indonesian summarising the reply
6. Jawaban: 1 (confirmed/yes), 0 (denied/no), or null (unclear)

Return ONLY this JSON:
{
  "phone": "+6289673681925",
  "text": "yaa",
  "category": "confirmed",
  "sentiment": "positive",
  "summary": "Toko mengkonfirmasi sudah menerima item",
  "jawaban": 1
}`

  const raw = await runImageChat(system, user, photoBase64, mimeType)
  console.log('[opencode] extractReplyFromImage raw:', raw)

  const json = raw.match(/\{[\s\S]*\}/)?.[0]
  if (!json) throw new Error('OpenCode did not return valid JSON for image extraction')

  const parsed = JSON.parse(json)
  return {
    phone:    parsed.phone    ?? '',
    text:     parsed.text     ?? '',
    category: parsed.category ?? 'unclear',
    sentiment: parsed.sentiment ?? 'neutral',
    summary:  parsed.summary  ?? '',
    jawaban:  typeof parsed.jawaban === 'number' ? parsed.jawaban : null,
  }
}

export async function mapHeaders(
  headers: string[],
  sampleRows: Record<string, unknown>[],
): Promise<ColumnMapping> {
  const prompt = `You are a data mapping assistant. Given these Excel column headers and sample rows
from an Indonesian/Chinese bilingual spreadsheet, identify which column corresponds to each field.

Headers: ${JSON.stringify(headers)}
Sample rows: ${JSON.stringify(sampleRows)}

Return JSON only:
{
  "phone": "<exact header string or null>",
  "store_name": "<exact header string or null>",
  "seq_no": "<exact header string or null>",
  "freezer_id": "<exact header string or null>",
  "exchange_count": "<exact header string or null>",
  "award_count": "<exact header string or null>",
  "total_count": "<exact header string or null>"
}`

  const text = await runChat(prompt, { maxTokens: 8192, temperature: 0 })
  return parseJsonFrom(text, "Header mapping") as ColumnMapping
}

export async function analyzeReply(
  replyText: string,
  bulan: string,
): Promise<ReplyAnalysis> {
  const prompt = `You are analyzing a WhatsApp reply from an Indonesian small business owner.
They were asked: "Apakah benar bahwa pada bulan ${bulan} toko bapak/ibu telah melakukan penukaran Stick ke distributor?"

Reply: "${replyText}"

Your job:
1. Determine if they confirmed (Ya/Yes) or denied (Tidak/No) the stick exchange
2. Handle informal Indonesian: "iya", "betul", "sudah", "ada" = confirmed; "tidak", "belum", "ngga", "gak", "blm", "ndak" = denied
3. If the reply is a question, unclear, or off-topic, set jawaban to null

Return JSON only — no explanation:
{
  "category": "confirmed" | "denied" | "question" | "unclear" | "other",
  "sentiment": "positive" | "neutral" | "negative",
  "summary": "<one sentence in Indonesian summarising the reply>",
  "jawaban": 1 | 0 | null
}

jawaban rules:
- 1  = store confirmed they did the exchange (category is "confirmed")
- 0  = store denied they did the exchange (category is "denied")
- null = cannot determine a clear yes or no (question/unclear/other)`

  const text = await runChat(prompt, { maxTokens: 8192, temperature: 0 })

  console.log("[opencode] analyzeReply input:", { replyText, bulan })
  console.log("[opencode] analyzeReply raw response:", text)

  const parsed = parseJsonFrom(text, "Reply analysis") as ReplyAnalysis

  console.log("[opencode] analyzeReply parsed result:", parsed)

  return parsed
}

export async function varyMessage(renderedMessage: string): Promise<string> {
  const prompt = `You are a WhatsApp message variation assistant. Rewrite the message below with
minor surface-level changes so it does not look identical to other messages in the same batch. Rules:
- Keep all {{variables}} and their values exactly as-is
- Keep the meaning, tone, and language (Indonesian) identical
- Only change: punctuation, minor word order, synonym swaps, spacing
- The result must still sound natural and professional
- Return ONLY the rewritten message text — no quotes, no explanation, no prefix

Message:
${renderedMessage}`

  const raw = (
    await runChat(prompt, { maxTokens: 8192, temperature: 0.4 })
  ).trim()
  return raw.replace(/^["']|["']$/g, "").trim()
}
