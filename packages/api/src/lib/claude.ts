import Anthropic from '@anthropic-ai/sdk'
import type { ColumnMapping, ReplyAnalysis } from '@aice/shared'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const MODEL = process.env.CLAUDE_MODEL ?? 'claude-3-haiku-20240307'

// ─── Job 1: Header mapping ────────────────────────────────────────────────────

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

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = (message.content[0] as { type: string; text: string }).text
  const json = text.match(/\{[\s\S]*\}/)?.[0]
  if (!json) throw new Error('Claude did not return valid JSON for header mapping')

  return JSON.parse(json) as ColumnMapping
}

// ─── Job 2: Reply analysis ────────────────────────────────────────────────────

export async function analyzeReply(
  replyText: string,
  bulan: string,
): Promise<ReplyAnalysis> {
  const prompt = `You are analyzing a WhatsApp reply from an Indonesian small business owner
in response to a confirmation request about ice cream stick exchange (penukaran stick es krim).

Context: The sender asked if the store performed a stick exchange in month ${bulan}.

Reply: "${replyText}"

Return JSON only:
{
  "category": "confirmed" | "denied" | "question" | "unclear" | "other",
  "sentiment": "positive" | "neutral" | "negative",
  "summary": "<one sentence in Indonesian>"
}`

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = (message.content[0] as { type: string; text: string }).text
  const json = text.match(/\{[\s\S]*\}/)?.[0]
  if (!json) throw new Error('Claude did not return valid JSON for reply analysis')

  return JSON.parse(json) as ReplyAnalysis
}

// ─── Job 3: Message variation ─────────────────────────────────────────────────

export async function varyMessage(renderedMessage: string): Promise<string> {
  const prompt = `You are a WhatsApp message variation assistant. Rewrite the message below with
minor surface-level changes so it does not look identical to other messages in the same batch. Rules:
- Keep all {{variables}} and their values exactly as-is
- Keep the meaning, tone, and language (Indonesian) identical
- Only change: punctuation, minor word order, synonym swaps, spacing
- The result must still sound natural and professional
- Return only the rewritten message, no explanation

Message: "${renderedMessage}"`

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  })

  return (message.content[0] as { type: string; text: string }).text.trim()
}
