import OpenAI from 'openai'
import type { ColumnMapping, ReplyAnalysis } from '@aice/shared'

const MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set')

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

function parseJsonFrom(text: string, context: string): unknown {
  const json = text.match(/\{[\s\S]*\}/)?.[0]
  if (!json) throw new Error(`${context} did not return valid JSON`)
  return JSON.parse(json)
}

function handleApiError(err: unknown, context: string): never {
  const status = (err as { status?: number }).status
  const message = (err as { message?: string }).message ?? 'Unknown error'

  let friendly: string
  switch (status) {
    case 400:
      friendly = `OpenAI API error (400): ${message}`
      break
    case 401:
      friendly = 'OpenAI API error (401): Invalid API key'
      break
    case 429:
      friendly = 'OpenAI API error (429): Rate limit exceeded or quota exhausted'
      break
    case 500:
      friendly = 'OpenAI API error (500): Internal server error'
      break
    default:
      friendly = `OpenAI API error (${status ?? 'unknown'}): ${message}`
  }

  console.error(`[OpenAI] ${context}:`, friendly)
  throw new Error(friendly)
}

async function runChat(
  prompt: string,
  opts: { maxTokens: number; temperature: number; jsonMode?: boolean },
): Promise<string> {
  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      response_format: opts.jsonMode ? { type: 'json_object' } : undefined,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = completion.choices[0]?.message?.content
    if (!text) throw new Error('OpenAI returned empty response')
    return text
  } catch (err: unknown) {
    handleApiError(err, 'runChat')
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

  const text = await runChat(prompt, { maxTokens: 512, temperature: 0, jsonMode: true })
  return parseJsonFrom(text, 'Header mapping') as ColumnMapping
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

  const text = await runChat(prompt, { maxTokens: 300, temperature: 0, jsonMode: true })

  console.log('[OpenAI] analyzeReply input:', { replyText, bulan })
  console.log('[OpenAI] analyzeReply raw response:', text)

  const parsed = parseJsonFrom(text, 'Reply analysis') as ReplyAnalysis

  console.log('[OpenAI] analyzeReply parsed result:', parsed)

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

  const raw = (await runChat(prompt, { maxTokens: 512, temperature: 0.4 })).trim()
  return raw.replace(/^["']|["']$/g, '').trim()
}
