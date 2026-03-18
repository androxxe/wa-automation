# WhatsApp Account Warmer — Specification

## Overview

A warming feature built into the existing `whatsapp-automation` monorepo. Operates on the existing multi-agent infrastructure (BrowserAgent / AgentManager) to simulate organic human WhatsApp activity between selected agents over a configurable period (default: 1 day).

Each agent has an explicit **Warm Mode flag** — only agents with `warmMode = true` participate in warming, and they are automatically blocked from campaign sends while in warm mode. Once a warming session completes, participating agents are automatically flagged as `isWarmed = true`.

Zero impact on existing campaign functionality. Single worker process manages all browser sessions (Option A: browser pool).

---

## Goals

- Make new WhatsApp numbers appear as active human users before running bulk campaigns
- Give the user explicit per-agent control over which numbers are warming vs. campaign-ready
- Reuse all existing infrastructure: BullMQ, BrowserAgent, AgentManager, Redis, Prisma
- No changes to existing campaign, contact, import, or reply logic

---

## Architecture

### New BullMQ Queue

- Queue name: `warm-queue`
- Separate from `whatsapp-messages` and `phone-check`
- Defined in `packages/api/src/lib/queue.ts` alongside existing queues
- Concurrency: `2` — max 2 warm sends at a time (one per active browser pair)

### Job Type: `WarmJob`

```ts
interface WarmJob {
  warmSessionId: string
  exchangeId:    string
  senderAgentId: number
  recipientAgentId: number
  senderPhone:   string
  recipientPhone: string
  message:       string   // pre-selected from warm-messages.json
  replyMessage:  string   // reply back — simulates conversation thread
  isReply:       boolean  // false = initial send, true = reply leg
}
```

### Message Bank

- File: `packages/worker/src/lib/warm-messages.json`
- 500 pre-written casual Indonesian messages + 500 paired replies (~83 per category)
- Categories: `greeting`, `food`, `weather`, `weekend`, `chit-chat`, `work-life`
- Messages and replies are paired by category — sender picks a message, recipient replies from the same category
- Worker tracks used message IDs per session to avoid repeats within a single session day

```json
{
  "messages": [
    { "id": 1, "category": "greeting", "text": "Halo, lagi ngapain?" },
    { "id": 2, "category": "food",     "text": "Udah makan siang belum?" }
  ],
  "replies": [
    { "id": 1, "category": "greeting", "text": "Lagi santai nih, kamu?" },
    { "id": 2, "category": "food",     "text": "Belum nih, mau kemana dulu?" }
  ]
}
```

---

## Database Changes

### Modify `Agent` model

Add two new fields to the existing `Agent` Prisma model:

```prisma
warmMode   Boolean   @default(false)  // user toggles manually per agent
isWarmed   Boolean   @default(false)  // auto-set true when a session completes
warmedAt   DateTime?                  // timestamp when isWarmed was set
```

**Behavior:**
- `warmMode = true` → agent is designated for warming; excluded from campaign job assignment
- `isWarmed = true` → agent has completed at least one warm session; shown as "Warmed ✓" in UI
- These two flags are independent — `warmMode` is manually managed, `isWarmed` is auto-managed

### New Model: `WarmSession`

```prisma
model WarmSession {
  id             String   @id @default(cuid())
  name           String
  status         String   @default("IDLE")
  // IDLE | RUNNING | PAUSED | COMPLETED | CANCELLED
  totalExchanges Int      // how many full send+reply exchanges to perform
  doneExchanges  Int      @default(0)
  partialFailure Boolean  @default(false)  // true if <50% of exchanges succeeded
  createdAt      DateTime @default(now())
  startedAt      DateTime?
  completedAt    DateTime?
  agents         WarmSessionAgent[]
  exchanges      WarmExchange[]
}
```

### New Model: `WarmSessionAgent`

Join table linking agents to a session. All agents are equal peers (no "main" vs "helper" roles).

```prisma
model WarmSessionAgent {
  warmSessionId  String
  agentId        Int
  session        WarmSession @relation(fields: [warmSessionId], references: [id], onDelete: Cascade)
  agent          Agent       @relation(fields: [agentId], references: [id], onDelete: Cascade)
  @@id([warmSessionId, agentId])
}
```

### New Model: `WarmExchange`

One record per send+reply pair.

```prisma
model WarmExchange {
  id               String      @id @default(cuid())
  warmSessionId    String
  session          WarmSession @relation(fields: [warmSessionId], references: [id], onDelete: Cascade)
  senderAgentId    Int
  recipientAgentId Int
  message          String      @db.Text
  replyMessage     String      @db.Text
  status           String      @default("PENDING")
  // PENDING | SENT | REPLIED | FAILED
  sentAt           DateTime?
  repliedAt        DateTime?
  failReason       String?     @db.Text
  createdAt        DateTime    @default(now())
}
```

---

## Agent Warm Mode Flag — Behavior Rules

| Agent state | Campaign sends | Warm sessions | UI appearance |
|---|---|---|---|
| `warmMode = false`, `isWarmed = false` | ✅ Eligible | ❌ Not shown in session picker | Normal card |
| `warmMode = true`, `isWarmed = false` | ❌ Blocked | ✅ Shown in session picker | Yellow "Warm Mode" badge |
| `warmMode = true`, `isWarmed = true` | ❌ Blocked | ✅ Shown in session picker | Yellow "Warm Mode" + green "Warmed ✓" |
| `warmMode = false`, `isWarmed = true` | ✅ Eligible | ❌ Not shown in session picker | Green "Warmed ✓" badge only |

### Campaign Job Assignment Guard

In the worker's agent selection logic (`packages/worker/src/index.ts`), the existing filter:

```ts
const eligibleAgents = onlineAgents.filter(a => !a.warmMode)
```

If all online agents are in warm mode, jobs are moved to delayed queue (same logic as daily cap exceeded).

### Active Session Lock

If an agent is currently in a `RUNNING` warm session, it cannot be assigned campaign jobs even if `warmMode` is flipped to `false` mid-session. The worker checks both `agent.warmMode` and whether `agentId` appears in any `RUNNING` WarmSession.

---

## Warming Logic

### Exchange Scheduling

When a session is started (`POST /api/warmer/sessions/:id/start`):

1. Generate all `WarmExchange` records upfront (one per planned exchange)
2. Build round-robin pairings across all session agents:
   - With 4 agents: pairs are 1→2, 2→3, 3→4, 4→1, 1→3, 2→4 (all combinations rotate)
   - With 2 agents: alternates 1→2, 2→1
   - With 3 agents: 1→2, 2→3, 3→1, 1→3, 3→2, 2→1
3. For each exchange, pick a random `(message, replyMessage)` pair from `warm-messages.json` in the same category, no repeats within the session
4. Enqueue `WarmJob` for the **send leg** with an incremental `delay`:
   - Delay between exchanges: Gaussian, mean 25 min ±5 min, floor 10 min, ceiling 45 min
   - Spread all exchanges across the day starting immediately

### Per-Exchange Flow

**Send leg (`isReply: false`):**
1. Worker picks up `WarmJob`
2. **Guard:** fetch `WarmSession` — if `status` is `CANCELLED` or `PAUSED`, discard job immediately without processing
3. Sender's `BrowserAgent` navigates to recipient phone in WhatsApp Web
4. Types and sends `message` with existing human-like keystroke simulation
5. Updates `WarmExchange.status → SENT`, sets `sentAt`
6. Enqueues a **reply leg** `WarmJob` with `delay: random(2min–8min)`

**Reply leg (`isReply: true`):**
1. Worker picks up reply `WarmJob`
2. **Guard:** fetch `WarmSession` — if `status` is `CANCELLED` or `PAUSED`, discard job immediately without processing
3. Recipient's `BrowserAgent` navigates to sender phone in WhatsApp Web
4. Types and sends `replyMessage` with same typing simulation
5. Updates `WarmExchange.status → REPLIED`, sets `repliedAt`
6. Increments `WarmSession.doneExchanges` using `{ increment: 1 }` (atomic DB-level increment)
7. Re-fetch session after increment to get the authoritative `doneExchanges` value
8. If `doneExchanges >= totalExchanges`:
   - Call `completeWarmSession` — which only proceeds if `status` is still `RUNNING` (idempotency guard via conditional update)
   - Sets `WarmSession.status → COMPLETED`, `completedAt = now()`
   - Sets `Agent.isWarmed = true`, `Agent.warmedAt = now()` for all session agents
   - Publishes SSE event `warm:completed` to session subscribers

### Reaction (Optional, 25% chance)

After the reply leg completes, a random reaction emoji (👍 ❤️ 😂 🔥 😮) is sent by the original sender on the recipient's reply message. Implemented via `BrowserAgent` DOM interaction on the message bubble. Skipped silently on failure — non-critical.

### Anti-Detection During Warming

- Reuses existing `BrowserAgent.sendMessage()` — same stealth fingerprint, ghost-cursor Bezier paths, per-keystroke timing
- No working hours restriction — warming runs 24h (looks more organic for account warm-up)
- Gaussian delay between exchanges (mean 25 min) prevents mechanical-looking patterns
- Messages never repeated within a session (track used IDs per `warmSessionId`)
- Message no-repeat is **best effort**: if the message bank for a category is exhausted, fall back to a different category rather than throwing. Log a warning if all 500 pairs are consumed before `totalExchanges` is reached (this cannot happen if `totalExchanges ≤ 500`, which is enforced by validation).

### Gaussian Delay Utility

JavaScript has no built-in Gaussian sampler. Use Box-Muller transform:

```ts
function gaussianMs(): number {
  const u1 = Math.random(), u2 = Math.random()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  const raw = WARM_EXCHANGE_MEAN_MS + z * WARM_EXCHANGE_STDDEV_MS
  return Math.min(Math.max(raw, WARM_EXCHANGE_MIN_MS), WARM_EXCHANGE_MAX_MS)
}
```

This utility lives in `packages/worker/src/lib/warm-worker.ts`.

### Round-Robin Pairing Algorithm

All directed pairs are pre-generated for the agent set, **interleaved by sender** so that every agent appears as a sender within the first `n` exchanges (where `n` = number of agents). This prevents the last agent in the list from being idle for too long at session start.

```ts
function buildPairings(agentIds: number[]): Array<[number, number]> {
  // Group per-sender recipient lists
  const bySender = new Map(agentIds.map(id => [id, agentIds.filter(x => x !== id)]))
  const ptr      = new Map(agentIds.map(id => [id, 0]))
  const result: Array<[number, number]> = []
  const total = agentIds.length * (agentIds.length - 1)
  let added = 0
  while (added < total) {
    for (const sender of agentIds) {
      const p = ptr.get(sender)!
      if (p < bySender.get(sender)!.length) {
        result.push([sender, bySender.get(sender)![p]])
        ptr.set(sender, p + 1)
        added++
      }
    }
  }
  return result
}
// 3 agents → [(1,2),(2,1),(3,1),(1,3),(2,3),(3,2)]  — agent 3 sends at index 2 (~50 min)
// 4 agents → 12 directed pairs, all 4 agents send within first 4 exchanges
```

To assign pairings to exchanges: `exchanges[k] → pairs[k % pairs.length]`. This ensures an even distribution even when `totalExchanges` is not a multiple of `pairs.length`.

### Error Handling

- If a send or reply fails: `WarmExchange.status → FAILED`, `failReason` saved, BullMQ retries up to 2 times with exponential backoff
- Persistent failure (all retries exhausted): exchange is skipped, session continues with remaining exchanges; `doneExchanges` is **not** incremented for failed exchanges — only `REPLIED` exchanges count
- After each persistent failure, still run the completion check (`doneExchanges + failedExchanges >= totalExchanges`) to detect when no more exchanges can possibly complete
- If fewer than 50% of exchanges reach `REPLIED` status: session marked `status → COMPLETED`, `partialFailure → true` (still marks agents as `isWarmed`)

### Completion Check Logic

The completion condition is triggered in two places:

1. After a successful reply leg: `doneExchanges >= totalExchanges`
2. After a persistent exchange failure: `doneExchanges + failedCount >= totalExchanges` (no more in-flight exchanges remain)

`completeWarmSession` must be **idempotent** — it uses a conditional DB update that only proceeds if `status = 'RUNNING'`:

```ts
const updated = await db.warmSession.updateMany({
  where: { id: sessionId, status: 'RUNNING' },
  data: { status: 'COMPLETED', completedAt: new Date(), partialFailure: ... },
})
if (updated.count === 0) return  // already completed or cancelled — skip
```

This prevents a race condition where two concurrent reply legs both see `doneExchanges >= totalExchanges` and both attempt to complete the session.

---

## New API Routes — `packages/api/src/routes/warmer.ts`

All routes mounted at `/api/warmer`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/warmer/sessions` | List all warm sessions with agent list + progress |
| `POST` | `/api/warmer/sessions` | Create session: `{ name, agentIds[], totalExchanges }` |
| `GET` | `/api/warmer/sessions/:id` | Session detail + full exchange log |
| `DELETE` | `/api/warmer/sessions/:id` | Delete session (IDLE or COMPLETED only) |
| `POST` | `/api/warmer/sessions/:id/start` | Enqueue all warm jobs, set status RUNNING |
| `POST` | `/api/warmer/sessions/:id/pause` | Drain warm-queue jobs for this session, set PAUSED |
| `POST` | `/api/warmer/sessions/:id/resume` | Re-enqueue remaining PENDING + stranded SENT exchanges, set RUNNING |
| `POST` | `/api/warmer/sessions/:id/cancel` | Drain warm-queue jobs for this session, set CANCELLED |
| `GET` | `/api/warmer/sessions/:id/events` | SSE stream — pushes `warm:progress` and `warm:completed` events |

### Agent warm mode routes (added to existing agents router)

| Method | Path | Description |
|---|---|---|
| `PATCH` | `/api/agents/:id` | Existing route — add `warmMode` to patchable fields |

### Validation rules for `POST /api/warmer/sessions`

- Minimum 2 agents required (need at least one sender and one recipient)
- Maximum 4 agents per session
- All selected agents must have `warmMode = true`
- No agent can be in another `RUNNING` session
- `totalExchanges` must be between 10 and 500

### Pause / Resume / Cancel — BullMQ Drain Strategy

BullMQ has no native per-session job drain. The drain process for pause and cancel:

```ts
async function drainSessionJobs(sessionId: string) {
  const jobs = await warmQueue.getJobs(['waiting', 'delayed'])
  await Promise.all(
    jobs
      .filter(j => j.data.warmSessionId === sessionId)
      .map(j => j.remove())
  )
}
```

**Pause flow:**
1. Set `WarmSession.status → PAUSED`
2. Call `drainSessionJobs(sessionId)` — removes all `waiting` and `delayed` jobs for this session
3. Jobs already picked up by the worker (in-flight) will detect `status = PAUSED` on their guard check and discard themselves without updating the exchange

**Resume flow:**
1. Set `WarmSession.status → RUNNING`
2. Re-enqueue exchanges in `PENDING` status: schedule with fresh Gaussian delays starting from now
3. Re-enqueue reply legs for exchanges in `SENT` status: these were sent but the reply job was drained during pause — re-enqueue with the minimum reply delay (`WARM_REPLY_MIN_MS`)
4. Exchanges in `REPLIED` or `FAILED` status are left untouched

**Cancel flow:**
1. Set `WarmSession.status → CANCELLED`
2. Call `drainSessionJobs(sessionId)`
3. In-flight jobs will detect `status = CANCELLED` on their guard check and discard themselves

---

## Worker Changes — `packages/worker/src/index.ts`

### New warm worker

```ts
const warmWorker = new Worker<WarmJob>('warm-queue', processWarmJob, {
  connection: redis,
  concurrency: 2,
  lockDuration: 15 * 60 * 1000,  // 15 min — covers reply delay window
})
```

### `processWarmJob` logic

```ts
async function processWarmJob(job: Job<WarmJob>) {
  const { senderAgentId, recipientAgentId, message, replyMessage, isReply, exchangeId, warmSessionId } = job.data

  // Guard: discard job if session is no longer active
  const sessionCheck = await db.warmSession.findUnique({ where: { id: warmSessionId }, select: { status: true } })
  if (!sessionCheck || sessionCheck.status === 'CANCELLED' || sessionCheck.status === 'PAUSED') return

  const agentId = isReply ? recipientAgentId : senderAgentId
  const targetPhone = isReply ? job.data.senderPhone : job.data.recipientPhone
  const text = isReply ? replyMessage : message

  const agent = agentManager.getAgent(agentId)
  if (!agent || agent.status !== 'connected') throw new Error(`Agent ${agentId} not connected`)

  await agent.sendMessage(targetPhone, text)

  if (!isReply) {
    await db.warmExchange.update({ where: { id: exchangeId }, data: { status: 'SENT', sentAt: new Date() } })
    const replyDelay = randomBetween(WARM_REPLY_MIN_MS, WARM_REPLY_MAX_MS)
    await warmQueue.add('warm-reply', { ...job.data, isReply: true }, { delay: replyDelay })
  } else {
    await db.warmExchange.update({ where: { id: exchangeId }, data: { status: 'REPLIED', repliedAt: new Date() } })
    await db.warmSession.update({ where: { id: warmSessionId }, data: { doneExchanges: { increment: 1 } } })
    // Re-fetch for authoritative count after atomic increment
    const session = await db.warmSession.findUnique({ where: { id: warmSessionId } })
    if (session && session.doneExchanges >= session.totalExchanges) {
      await completeWarmSession(warmSessionId)
    }
    // Optional reaction (25% chance) — silent fail
    maybeReact(job.data).catch(() => {})
  }
}
```

### `completeWarmSession`

Uses a conditional `updateMany` to ensure idempotency — only one concurrent caller can win the `status = 'RUNNING'` check:

```ts
async function completeWarmSession(sessionId: string) {
  const failedCount = await db.warmExchange.count({ where: { warmSessionId: sessionId, status: 'FAILED' } })
  const repliedCount = await db.warmExchange.count({ where: { warmSessionId: sessionId, status: 'REPLIED' } })
  const session = await db.warmSession.findUnique({ where: { id: sessionId } })
  if (!session) return

  const partialFailure = repliedCount < session.totalExchanges / 2

  // Atomic idempotency guard — only proceeds if status is still RUNNING
  const updated = await db.warmSession.updateMany({
    where: { id: sessionId, status: 'RUNNING' },
    data: { status: 'COMPLETED', completedAt: new Date(), partialFailure },
  })
  if (updated.count === 0) return  // already completed or cancelled by another job — skip

  const sessionAgents = await db.warmSessionAgent.findMany({ where: { warmSessionId: sessionId } })
  await db.agent.updateMany({
    where: { id: { in: sessionAgents.map(a => a.agentId) } },
    data: { isWarmed: true, warmedAt: new Date() },
  })
  redis.publish(`warm:events:${sessionId}`, JSON.stringify({ event: 'warm:completed', sessionId, partialFailure }))
}
```

### Persistent Failure Completion Trigger

When a BullMQ job exhausts all retries (failed event fires), also check if the session can be completed:

```ts
warmWorker.on('failed', async (job, err) => {
  if (!job) return
  const { exchangeId, warmSessionId } = job.data
  await db.warmExchange.update({
    where: { id: exchangeId },
    data: { status: 'FAILED', failReason: err.message },
  })
  // Check if all exchanges are now resolved (REPLIED + FAILED >= totalExchanges)
  const session = await db.warmSession.findUnique({ where: { id: warmSessionId } })
  if (!session || session.status !== 'RUNNING') return
  const resolvedCount = await db.warmExchange.count({
    where: { warmSessionId, status: { in: ['REPLIED', 'FAILED'] } },
  })
  if (resolvedCount >= session.totalExchanges) {
    await completeWarmSession(warmSessionId)
  }
})
```

---

## Shared Types — `packages/shared/src/index.ts`

```ts
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
```

---

## SSE Implementation Notes

The warmer SSE endpoint (`GET /api/warmer/sessions/:id/events`) uses Redis pub/sub, which requires a **dedicated subscriber Redis connection** in the API process (the shared Redis client cannot subscribe and issue commands simultaneously).

```ts
// In warmer.ts route handler
const sub = redis.duplicate()  // dedicated subscriber connection
await sub.subscribe(`warm:events:${sessionId}`)
sub.on('message', (_, msg) => res.write(`data: ${msg}\n\n`))

// Cleanup on client disconnect — prevents subscriber memory leak
req.on('close', () => {
  sub.unsubscribe()
  sub.quit()
})
```

Worker publishes via the main Redis client:
```ts
redis.publish(`warm:events:${sessionId}`, JSON.stringify({ event: 'warm:progress', ... }))
```

Two SSE events are emitted:
- `warm:progress` — emitted after each exchange reaches `REPLIED` or `FAILED` status; payload includes `{ event, sessionId, exchangeId, status, doneExchanges, totalExchanges }`
- `warm:completed` — emitted once when session completes; payload includes `{ event, sessionId, partialFailure }`

---

## Frontend — New Page: `Warmer`

**Route:** `/warmer`
**File:** `packages/web/src/pages/Warmer.tsx`
**Nav:** New sidebar item between "Agents" and "Responses"

### Page Layout

#### Sessions List (top section)

Table with columns:

| Column | Content |
|---|---|
| Name | Session name |
| Agents | Avatar-style list of participating agent names |
| Progress | `doneExchanges / totalExchanges` progress bar + percentage |
| Status | Badge: IDLE (grey) / RUNNING (blue pulse) / PAUSED (yellow) / COMPLETED (green) / CANCELLED (red) |
| Actions | Start / Pause / Resume / Cancel / Delete buttons (contextual by status) |

"New Session" button opens the create modal.

#### Create Session Modal

Fields:
- **Name** — text input
- **Agents** — multi-select checkboxes, shows only agents with `warmMode = true` and status ONLINE. Each option shows agent name + phone number. Minimum 2, maximum 4.
- **Total Exchanges** — number input, default 30, range 10–500. Helper text: "Each exchange = 1 message + 1 reply. ~25 min between exchanges."
- **Estimated duration** — computed display: `totalExchanges × 25 min ÷ 60` hours (e.g., "~12.5 hours")

Validation errors shown inline. "Create" button disabled until valid.

#### Session Detail (expandable row or `/warmer/:id` route)

- Header: session name, status badge, progress bar, start/pause/cancel
- **Exchange log table:**

| # | Sender | Recipient | Message | Reply | Status | Sent At | Replied At |
|---|---|---|---|---|---|---|---|
| 1 | Agent 1 | Agent 2 | "Halo, lagi ngapain?" | "Lagi santai nih" | REPLIED | 10:02 | 10:09 |

- Status badges: PENDING (grey) / SENT (blue) / REPLIED (green) / FAILED (red)
- Live updates via SSE (`/api/warmer/sessions/:id/events`) — new exchanges animate in as they complete

### Agents Page Changes

Each agent card shows additional badges:

- **"Warm Mode"** — yellow badge when `warmMode = true`
- **"Warmed ✓"** — green badge when `isWarmed = true`

The Edit Agent modal (or inline toggle) includes a **"Warm Mode" toggle switch** with label:
> "Enable warm mode — agent will be excluded from campaigns and available for warming sessions"

---

## Files to Create / Modify

| Action | File | Change |
|---|---|---|
| **Create** | `spec/WARMER-SPEC.md` | This document |
| **Create** | `packages/worker/src/lib/warm-messages.json` | 200 messages + 200 replies |
| **Create** | `packages/worker/src/lib/warm-worker.ts` | BullMQ warm job processor |
| **Create** | `packages/api/src/routes/warmer.ts` | All warm session API routes |
| **Create** | `packages/web/src/pages/Warmer.tsx` | Warmer UI page |
| **Modify** | `packages/api/prisma/schema.prisma` | Add WarmSession, WarmSessionAgent, WarmExchange models; add `warmMode`, `isWarmed`, `warmedAt` to Agent |
| **Modify** | `packages/api/src/lib/queue.ts` | Add `warmQueue` export |
| **Modify** | `packages/shared/src/index.ts` | Add WarmJob, WarmSessionStatus, WarmExchangeStatus, WarmSessionInfo, WarmExchangeInfo |
| **Modify** | `packages/worker/src/index.ts` | Register warmWorker, add campaign agent eligibility guard |
| **Modify** | `packages/web/src/App.tsx` | Add `/warmer` route |
| **Modify** | `packages/web/src/components/layout/Sidebar.tsx` | Add "Warmer" nav item |
| **Modify** | `packages/web/src/pages/Agents.tsx` | Add warmMode toggle + isWarmed badge to agent cards |
| **Modify** | `.env.example` | Add `WARM_EXCHANGE_MEAN_MS`, `WARM_EXCHANGE_STDDEV_MS` |

---

## New Environment Variables

```env
# Warmer — delay between exchanges (Gaussian)
WARM_EXCHANGE_MEAN_MS=1500000      # mean 25 minutes between exchanges
WARM_EXCHANGE_STDDEV_MS=300000     # ±5 minutes std deviation
WARM_EXCHANGE_MIN_MS=600000        # floor 10 minutes
WARM_EXCHANGE_MAX_MS=2700000       # ceiling 45 minutes

# Warmer — reply delay (how long after receiving before replying)
WARM_REPLY_MIN_MS=120000           # min 2 minutes
WARM_REPLY_MAX_MS=480000           # max 8 minutes
```

---

## Edge Cases Reference

A summary of all edge cases that must be handled, for implementation checklist purposes.

### Session Lifecycle

| Edge Case | Handling |
|---|---|
| Create with <2 or >4 agents | 400 validation error |
| Create with agent not in `warmMode` | 400 validation error |
| Create with agent already in a `RUNNING` session | 400 validation error |
| `totalExchanges` outside 10–500 | 400 validation error |
| Delete a `RUNNING` or `PAUSED` or `CANCELLED` session | 409 error — only `IDLE` or `COMPLETED` deletable |
| Start a session not in `IDLE` status | 409 error |
| Pause a session not in `RUNNING` status | 409 error |
| Resume a session not in `PAUSED` status | 409 error |
| Cancel a session already `COMPLETED` or `CANCELLED` | 409 error |

### Worker / Job Execution

| Edge Case | Handling |
|---|---|
| Job fires after session `CANCELLED` | Guard at job start: discard silently |
| Job fires after session `PAUSED` | Guard at job start: discard silently |
| Agent not connected when job fires | Throw → BullMQ retries up to 2× with exponential backoff |
| All retries exhausted (persistent failure) | Mark exchange `FAILED`, run completion check |
| Two concurrent reply legs both see completion condition | `completeWarmSession` uses `updateMany WHERE status='RUNNING'` — only one wins |
| `completeWarmSession` called when session already `CANCELLED` | `updated.count === 0` → return early |
| `<50%` exchanges reach `REPLIED` | `completeWarmSession` sets `partialFailure = true` |
| Reaction emoji DOM interaction throws | Wrapped in `.catch(() => {})` — silent skip |

### Pause / Resume

| Edge Case | Handling |
|---|---|
| In-flight job (already picked up) during pause | Worker guard detects `PAUSED`, discards without updating exchange |
| `SENT` exchanges when session is paused | Reply jobs drained; on resume, re-enqueue reply leg with `WARM_REPLY_MIN_MS` delay |
| `PENDING` exchanges when session is paused | Re-enqueued on resume with fresh Gaussian delays from now |
| `REPLIED` or `FAILED` exchanges on resume | Left untouched — not re-enqueued |

### Agent State

| Edge Case | Handling |
|---|---|
| `warmMode` flipped to `false` while agent is in `RUNNING` session | Agent still excluded from campaign sends (worker checks both `warmMode` and active session membership) |
| Agent goes offline mid-session (reply leg) | Reply job throws → retries → marks exchange `FAILED` → completion check runs |

### Message Bank

| Edge Case | Handling |
|---|---|
| All pairs in a category exhausted | Fall back to a random different category |
| `totalExchanges > 500` | Prevented by validation (max 500) |

### SSE

| Edge Case | Handling |
|---|---|
| Client disconnects from SSE stream | `req.on('close')` unsubscribes and quits the dedicated Redis subscriber |
| Multiple clients subscribed to same session | Each gets its own `redis.duplicate()` subscriber — independent cleanup |

---

## Implementation Order

When building, implement in this order to avoid dependency issues:

1. `packages/api/prisma/schema.prisma` — add models + Agent fields, run migration
2. `packages/shared/src/index.ts` — add WarmJob types
3. `packages/api/src/lib/queue.ts` — add warmQueue
4. `packages/worker/src/lib/warm-messages.json` — 200 message bank
5. `packages/worker/src/lib/warm-worker.ts` — job processor
6. `packages/worker/src/index.ts` — register worker + campaign guard
7. `packages/api/src/routes/warmer.ts` — API routes
8. `packages/web/src/pages/Warmer.tsx` — UI page
9. `packages/web/src/App.tsx` + `Sidebar.tsx` — routing + nav
10. `packages/web/src/pages/Agents.tsx` — warmMode toggle + badges
11. `.env.example` — new env vars
