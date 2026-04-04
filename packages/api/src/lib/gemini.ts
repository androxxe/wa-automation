import { GoogleGenerativeAI } from '@google/generative-ai'
import type { ColumnMapping, ReplyAnalysis } from '@aice/shared'

const MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY ?? '')
const model = genAI.getGenerativeModel({ model: MODEL })

function parseJsonFrom(text: string, context: string): unknown {
  const json = text.match(/\{[\s\S]*\}/)?.[0]
  if (!json) throw new Error(`${context} did not return valid JSON`)
  return JSON.parse(json)
}

async function runChat(prompt: string, opts: { maxTokens: number; temperature: number }): Promise<string> {
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: opts.maxTokens,
      temperature: opts.temperature,
    },
  })
  return result.response.text()
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

  const text = await runChat(prompt, { maxTokens: 512, temperature: 0 })
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

  const text = await runChat(prompt, { maxTokens: 300, temperature: 0 })
  return parseJsonFrom(text, 'Reply analysis') as ReplyAnalysis
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
