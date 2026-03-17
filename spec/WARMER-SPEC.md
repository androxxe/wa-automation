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
- 200 pre-written casual Indonesian messages + 200 paired replies
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
2. Sender's `BrowserAgent` navigates to recipient phone in WhatsApp Web
3. Types and sends `message` with existing human-like keystroke simulation
4. Updates `WarmExchange.status → SENT`, sets `sentAt`
5. Enqueues a **reply leg** `WarmJob` with `delay: random(2min–8min)`

**Reply leg (`isReply: true`):**
1. Worker picks up reply `WarmJob`
2. Recipient's `BrowserAgent` navigates to sender phone in WhatsApp Web
3. Types and sends `replyMessage` with same typing simulation
4. Updates `WarmExchange.status → REPLIED`, sets `repliedAt`
5. Increments `WarmSession.doneExchanges`
6. If `doneExchanges >= totalExchanges`:
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

### Error Handling

- If a send or reply fails: `WarmExchange.status → FAILED`, `failReason` saved, BullMQ retries up to 2 times with exponential backoff
- Persistent failure: exchange is skipped, session continues with remaining exchanges
- If fewer than 50% of exchanges complete successfully: session marked `status → COMPLETED` with a `partialFailure` note (still marks agents as `isWarmed`)

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
| `POST` | `/api/warmer/sessions/:id/pause` | Drain warm-queue for this session, set PAUSED |
| `POST` | `/api/warmer/sessions/:id/resume` | Re-enqueue remaining exchanges, set RUNNING |
| `POST` | `/api/warmer/sessions/:id/cancel` | Remove BullMQ jobs, set CANCELLED |
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
- `totalExchanges` must be between 10 and 200

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

  const agentId = isReply ? recipientAgentId : senderAgentId
  const targetPhone = isReply ? job.data.senderPhone : job.data.recipientPhone
  const text = isReply ? replyMessage : message

  const agent = agentManager.getAgent(agentId)
  if (!agent || agent.status !== 'connected') throw new Error(`Agent ${agentId} not connected`)

  await agent.sendMessage(targetPhone, text)

  if (!isReply) {
    // schedule reply leg
    const replyDelay = randomBetween(2 * 60 * 1000, 8 * 60 * 1000)
    await warmQueue.add('warm-reply', { ...job.data, isReply: true }, { delay: replyDelay })
    await db.warmExchange.update({ where: { id: exchangeId }, data: { status: 'SENT', sentAt: new Date() } })
  } else {
    await db.warmExchange.update({ where: { id: exchangeId }, data: { status: 'REPLIED', repliedAt: new Date() } })
    await db.warmSession.update({
      where: { id: warmSessionId },
      data: { doneExchanges: { increment: 1 } },
    })
    // check completion
    const session = await db.warmSession.findUnique({ where: { id: warmSessionId } })
    if (session && session.doneExchanges >= session.totalExchanges) {
      await completeWarmSession(session)
    }
  }
}
```

### `completeWarmSession`

```ts
async function completeWarmSession(session: WarmSession) {
  await db.warmSession.update({
    where: { id: session.id },
    data: { status: 'COMPLETED', completedAt: new Date() },
  })
  const sessionAgents = await db.warmSessionAgent.findMany({ where: { warmSessionId: session.id } })
  await db.agent.updateMany({
    where: { id: { in: sessionAgents.map(a => a.agentId) } },
    data: { isWarmed: true, warmedAt: new Date() },
  })
  // publish SSE via Redis
  redis.publish(`warm:events:${session.id}`, JSON.stringify({ event: 'warm:completed', sessionId: session.id }))
}
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
- **Total Exchanges** — number input, default 30, range 10–200. Helper text: "Each exchange = 1 message + 1 reply. ~25 min between exchanges."
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
