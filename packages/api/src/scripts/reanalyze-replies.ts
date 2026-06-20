// ─── Bulk re-analyzer for auto-skipped replies ────────────────────────────────
// Re-processes Reply records that were auto-skipped (claudeSummary =
// 'Auto-skipped (DISABLE_REPLY_ANALYSIS is set)') AND that the operator has
// manually re-categorized in the Responses page (claudeCategory != 'unclear').
// This is a QA pass: the operator's manual category will be overwritten by
// the AI result, so they can verify whether the AI now agrees with them.
//
// Usage:
//   pnpm --filter @aice/api reanalyze:replies
//   pnpm --filter @aice/api reanalyze:replies -- --dry-run
//   pnpm --filter @aice/api reanalyze:replies -- --limit 100 --offset 50
//   pnpm --filter @aice/api reanalyze:replies -- --batch-size 25

import { PrismaClient, Prisma } from "@prisma/client"

const db = new PrismaClient()

const STUB_SUMMARY = "Auto-skipped (DISABLE_REPLY_ANALYSIS is set)"
const SCRIPT_NAME = "bulk-script"
const DEFAULT_BATCH = 20
const OPENCODE_URL = "https://opencode.ai/zen/go/v1"

// ─── CLI flags ────────────────────────────────────────────────────────────────

interface Flags {
  dryRun: boolean
  limit: number | null
  offset: number
  batchSize: number
}

function parseFlags(): Flags {
  const args = process.argv.slice(2)
  const get = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const num = (s: string | undefined, fallback: number): number => {
    if (s === undefined) return fallback
    const n = parseInt(s, 10)
    if (Number.isNaN(n) || n < 0)
      throw new Error(`Invalid number for arg: ${s}`)
    return n
  }

  return {
    dryRun: args.includes("--dry-run"),
    limit: get("--limit") ? num(get("--limit"), -1) : null,
    offset: num(get("--offset"), 0),
    batchSize: num(get("--batch-size"), DEFAULT_BATCH),
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReplyInput {
  id: string
  bulan: string
  body: string
}

interface ReplyResult {
  id: string
  category: string
  sentiment: string
  summary: string
  jawaban: 1 | 0 | null
}

// ─── opencode call (Option B — inline, no export from opencode.ts) ────────────

async function callOpencode(prompt: string): Promise<string> {
  if (!process.env.OPCODE_API_KEY) {
    throw new Error("OPCODE_API_KEY is not set")
  }
  const model = process.env.OPCODE_MODEL ?? "deepseek-v4-flash"
  const url = `${OPENCODE_URL}/chat/completions`

  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPCODE_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 16384,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Output only the exact requested JSON array. No reasoning, no markdown, no code blocks.",
          },
          { role: "user", content: prompt },
        ],
      }),
    })
  } catch (err) {
    const code = (err as { code?: string }).code
    const msg = err instanceof Error ? err.message : String(err)
    const detail = code ? `(${code})` : ""
    throw new Error(`Network error calling ${url}: ${msg} ${detail}`.trim())
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw Object.assign(new Error(`opencode ${res.status}: ${text}`), {
      status: res.status,
    })
  }

  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const text = body.choices?.[0]?.message?.content
  if (!text) throw new Error("Empty opencode response")
  return text
}

// ─── Prompt + parse ───────────────────────────────────────────────────────────

function buildPrompt(replies: ReplyInput[]): string {
  const inputJson = JSON.stringify(replies)
  return `You are analyzing ${replies.length} WhatsApp replies from Indonesian small business owners.
Each was asked whether they did a stick exchange with the distributor during a specific month (bulan).

For each reply, return one JSON object with the same id. Output a JSON array of length ${replies.length}, in the same order as input. If you cannot determine a result for an entry, still include it with category="unclear" and jawaban=null.

Informal Indonesian handling:
- Confirmed: "iya", "betul", "sudah", "ada", "benar", "ok", "siap"
- Denied:    "tidak", "belum", "ngga", "gak", "blm", "ndak", "belom"
- Question / unclear / off-topic → jawaban: null

Input array:
${inputJson}

Return JSON array only — no explanation, no markdown, no code fences:
[
  {
    "id": "<same as input id>",
    "category":  "confirmed" | "denied" | "question" | "unclear" | "other",
    "sentiment": "positive" | "neutral" | "negative",
    "summary":   "<one sentence in Indonesian>",
    "jawaban":   1 | 0 | null
  },
  ...
]`
}

function parseJsonArray(text: string): ReplyResult[] {
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) throw new Error("No JSON array found in AI response")
  const parsed: unknown = JSON.parse(match[0])
  if (!Array.isArray(parsed)) throw new Error("AI response is not a JSON array")
  return parsed as ReplyResult[]
}

function validateResult(entry: unknown): entry is ReplyResult {
  if (typeof entry !== "object" || entry === null) return false
  const e = entry as Record<string, unknown>
  return (
    typeof e.id === "string" &&
    typeof e.category === "string" &&
    typeof e.sentiment === "string" &&
    typeof e.summary === "string" &&
    (e.jawaban === 1 || e.jawaban === 0 || e.jawaban === null)
  )
}

// ─── DB query ────────────────────────────────────────────────────────────────

interface StubReply {
  id: string
  phone: string
  messageId: string
  body: string
  message: {
    id: string
    metadata: Prisma.JsonValue | null
    campaign: { bulan: string }
  }
}

async function fetchStubReplies(flags: Flags): Promise<StubReply[]> {
  return db.reply.findMany({
    where: {
      AND: [{ claudeSummary: STUB_SUMMARY }, { claudeCategory: "unclear" }],
      body: { not: "" },
    },
    select: {
      id: true,
      messageId: true,
      phone: true,
      body: true,
      message: {
        select: {
          id: true,
          metadata: true,
          campaign: { select: { bulan: true } },
        },
      },
    },
    orderBy: { receivedAt: "asc" },
    take: flags.limit ?? undefined,
    skip: flags.offset,
  })
}

// ─── Batch processing ────────────────────────────────────────────────────────

interface BatchResult {
  batchSize: number
  aiReturned: number
  updated: number
  skipped: number
  failed: boolean
  error?: string
}

async function processBatch(
  replies: StubReply[],
  batchSize: number,
): Promise<BatchResult> {
  const inputs: ReplyInput[] = replies.map((r) => ({
    id: r.id,
    bulan: r.message.campaign.bulan,
    body: r.body,
  }))

  const prompt = buildPrompt(inputs)
  const model = process.env.OPCODE_MODEL ?? "deepseek-v4-flash"
  const now = new Date()

  // Retry 2x with 5s/15s backoff for 429/5xx
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = await callOpencode(prompt)
      const parsed = parseJsonArray(text)
      const byId = new Map(parsed.filter(validateResult).map((e) => [e.id, e]))
      const matched = inputs
        .map((i) => byId.get(i.id))
        .filter((e): e is ReplyResult => !!e)
      const unmatched = inputs.length - matched.length

      if (matched.length === 0) {
        return {
          batchSize: inputs.length,
          aiReturned: parsed.length,
          updated: 0,
          skipped: inputs.length,
          failed: true,
          error: "no valid entries matched",
        }
      }

      // Per-row updates wrapped in a single transaction.
      // Reply needs unique data per row (category/summary/jawaban/claudeRaw).
      // Message needs unique data per row (merged existing metadata).
      const replyUpdates = matched.map((m) =>
        db.reply.update({
          where: { id: m.id },
          data: {
            claudeCategory: m.category,
            claudeSentiment: m.sentiment,
            claudeSummary: m.summary,
            jawaban: m.jawaban,
            claudeRaw: {
              model,
              requestedAt: now.toISOString(),
              batchedWith: inputs.map((i) => i.id),
              response: m,
            } as unknown as Prisma.InputJsonValue,
          },
        }),
      )

      const matchedReplyIds = new Set(matched.map((m) => m.id))
      const messageUpdates = replies
        .filter((r) => matchedReplyIds.has(r.id))
        .map((r) => {
          const existing =
            r.message.metadata && typeof r.message.metadata === "object"
              ? (r.message.metadata as Record<string, unknown>)
              : {}
          return db.message.update({
            where: { id: r.messageId },
            data: {
              metadata: {
                ...existing,
                reanalyzedBy: SCRIPT_NAME,
                reanalyzedAt: now.toISOString(),
              } as unknown as Prisma.InputJsonValue,
            },
          })
        })

      await db.$transaction([...replyUpdates, ...messageUpdates])

      return {
        batchSize: inputs.length,
        aiReturned: parsed.length,
        updated: matched.length,
        skipped: unmatched,
        failed: false,
      }
    } catch (err) {
      lastErr = err
      const status = (err as { status?: number }).status
      if ((status === 429 || (status && status >= 500)) && attempt < 2) {
        const delayMs = attempt === 0 ? 5_000 : 15_000
        console.warn(
          `[reanalyze] batch attempt ${attempt + 1} got ${status}, retrying in ${delayMs / 1000}s…`,
        )
        await new Promise((r) => setTimeout(r, delayMs))
        continue
      }
      break
    }
  }

  return {
    batchSize: inputs.length,
    aiReturned: 0,
    updated: 0,
    skipped: inputs.length,
    failed: true,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
  }
}

// ─── Dry-run preview ─────────────────────────────────────────────────────────

function previewDryRun(replies: StubReply[]): void {
  console.log(`\n[dry-run] Would process ${replies.length} stub replies:\n`)
  for (const r of replies.slice(0, 10)) {
    const body = r.body.slice(0, 60).replace(/\n/g, " ")
    const bulan = r.message.campaign.bulan
    console.log(
      `  [${bulan.padEnd(10)}] ${r.phone ?? r.id.slice(0, 8)} "${body}"`,
    )
  }
  if (replies.length > 10) console.log(`  ... and ${replies.length - 10} more`)
  console.log(
    "\nDry run — no AI calls made, no DB writes. Pass without --dry-run to apply.",
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags()

  if (flags.batchSize < 1 || flags.batchSize > 200) {
    throw new Error(`--batch-size must be 1-200, got ${flags.batchSize}`)
  }

  console.log(
    "\n[reanalyze] ─── Bulk Reply Re-Analyzer ─────────────────────────",
  )
  console.log(`[reanalyze] Flags: ${JSON.stringify(flags)}`)

  const replies = await fetchStubReplies(flags)
  console.log(
    `[reanalyze] Found ${replies.length} manually-categorized stub replies`,
  )

  if (replies.length === 0) {
    console.log("[reanalyze] Nothing to process. Exiting.")
    return
  }

  if (flags.dryRun) {
    previewDryRun(replies)
    return
  }

  const totalBatches = Math.ceil(replies.length / flags.batchSize)
  console.log(
    `[reanalyze] Batch size: ${flags.batchSize} → ${totalBatches} batch(es) to process\n`,
  )

  let totalUpdated = 0
  let totalSkipped = 0
  let failedBatches = 0
  const startTime = Date.now()

  for (let i = 0; i < totalBatches; i++) {
    const batch = replies.slice(i * flags.batchSize, (i + 1) * flags.batchSize)
    console.log(
      `[reanalyze] [${i + 1}/${totalBatches}] processing ${batch.length} replies…`,
    )

    const result = await processBatch(batch, flags.batchSize)

    if (result.failed) {
      failedBatches++
      console.error(
        `[reanalyze] [${i + 1}/${totalBatches}] ✗ FAILED: ${result.error}`,
      )
    } else {
      totalUpdated += result.updated
      totalSkipped += result.skipped
      console.log(
        `[reanalyze] [${i + 1}/${totalBatches}] ✓ ${result.updated}/${batch.length} updated` +
          (result.skipped > 0 ? `, ${result.skipped} skipped` : ""),
      )
    }
  }

  const durationMs = Date.now() - startTime
  const mins = Math.floor(durationMs / 60_000)
  const secs = Math.floor((durationMs % 60_000) / 1000)

  console.log(
    "\n[reanalyze] ─── DONE ─────────────────────────────────────────",
  )
  console.log(`[reanalyze] Total replies:    ${replies.length}`)
  console.log(`[reanalyze] Updated:          ${totalUpdated}`)
  console.log(
    `[reanalyze] Skipped:          ${totalSkipped}  (unmatched by AI id)`,
  )
  console.log(`[reanalyze] Failed batches:   ${failedBatches}`)
  console.log(`[reanalyze] Duration:         ${mins}m ${secs}s`)
  console.log(
    `[reanalyze] Re-run safe:      no — successful AI run overwrites claudeSummary, dropping the row from the next filter; failed batches leave rows in place and will be retried`,
  )

  if (failedBatches > 0) {
    console.log(
      "\n[reanalyze] ⚠ Some batches failed. Re-run to retry — processed rows will be skipped automatically.",
    )
    process.exit(1)
  }
}

main()
  .catch((err) => {
    console.error("[reanalyze] Fatal error:", err)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
