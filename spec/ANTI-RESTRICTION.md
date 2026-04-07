# Anti-Restriction System — Specification

## Problem

Agents get restricted by WhatsApp after ~35 messages/day despite existing anti-detection measures (stealth script, Gaussian delays, Claude variation, round-robin distribution). This is far below the configured `DAILY_SEND_CAP` of 150.

Running 7 agents simultaneously also consumes significant laptop resources, primarily from reply polling (each agent navigates to 30+ phones back-to-back every 60s).

### Root Cause Analysis

| Signal | Current State | Risk |
|---|---|---|
| **Navigation pattern** | Every send navigates to `web.whatsapp.com/send?phone={number}` — a strong bot signal. Real humans search/select contacts from their chat list. | HIGH |
| **Reply polling** | Each agent visits 30+ phone numbers via URL in rapid succession every 60s. Back-to-back navigations with no idle time. Heavy CPU/DOM usage. | HIGH |
| **No warm tracking** | `isWarmed` is a boolean with no history. No way to see how much warming an agent has done. | MEDIUM |

---

## Goals

1. **Raise the restriction threshold** by changing navigation patterns and reducing polling footprint
2. **Reduce laptop resource usage** by cutting reply polling volume significantly
3. **Track warm session history** for visibility (informational only, never enforced)
4. **Zero impact** on existing campaign, contact, import, reply analysis, or export logic

---

## Architecture

Three lightweight changes:

```
1. Sidebar Search Navigation     — 70% of sends use WA's sidebar search instead of URL nav
2. Optimized Reply Polling       — batch 30→10, adaptive intervals, delays between visits
3. Warm Day Tracking             — DB counter for display, no enforcement
```

No trust scores, no block detection, no organic behavior simulation.

---

## 1. Sidebar Search Navigation

### 1.1 New Method: `sendMessageViaSidebar()`

**File:** `packages/worker/src/lib/browser-agent.ts`

Alternative to the current URL-based `sendMessage()` that uses WhatsApp's sidebar search:

```
1. Navigate to web.whatsapp.com (stay on main page)
2. Wait for chat list to load
3. Click the search box at top of sidebar
4. Type the phone number character by character (same typing simulation as current send)
5. Wait 1-2s for search results to appear
6. Click the first matching result (or press Enter to start new chat)
7. Wait for chat panel to load
8. Check for "not registered" popup (same detection as current sendMessage)
9. Type message + send (same as current flow)
```

**Key difference:** The phone number is searched from within WA's UI, not passed as a URL parameter. This matches how a human would message a new contact. WhatsApp's automation detection weighs URL-based `send?phone=` patterns heavily.

### 1.2 Mixed Navigation Strategy

**File:** `packages/worker/src/index.ts` (message worker, step 4)

```ts
// 4. Send — mixed navigation
const useSidebar = Math.random() < SIDEBAR_RATIO // default 0.70
if (useSidebar) {
  log(`sending via sidebar search to ${phone}…`)
  await agent.sendMessageViaSidebar(phone, body)
} else {
  log(`sending via URL to ${phone}…`)
  await agent.sendMessage(phone, body)
}
```

**Rationale:**
- 70% sidebar search: human-like behavior for most sends
- 30% URL navigation: realistic for when someone clicks a WA.me link
- Pure sidebar would also be suspicious — humans sometimes use direct links

### 1.3 Fallback Behavior

If sidebar search fails (search box selector not found, no results, timeout):

```ts
// In sendMessageViaSidebar — if search fails, fall through to URL method
try {
  // ... sidebar search logic
} catch {
  log('sidebar search failed, falling back to URL navigation')
  await this.sendMessage(phone, body) // reuse existing method
  return
}
```

No job failure from navigation issues — always falls back to the proven URL method.

### 1.4 Configuration

```env
SIDEBAR_SEND_RATIO=0.70  # 0.0 = all URL, 1.0 = all sidebar
```

---

## 2. Optimized Reply Polling

This is the biggest win for **both** anti-detection and resource usage.

### 2.1 Reduced Batch Size

**File:** `packages/worker/src/index.ts`

```env
# Before
REPLY_BATCH_SIZE=30

# After
REPLY_BATCH_SIZE=10
```

Each agent polls at most 10 phones per cycle instead of 30. This cuts DOM navigations by 66% per cycle.

### 2.2 Random Delays Between Phone Visits

**File:** `packages/worker/src/lib/browser-agent.ts` (`pollReplies`)

Current behavior: visits phones back-to-back with no delay.

New behavior: add a random 15-45 second delay between each phone visit:

```ts
for (const [phone, sentAt] of sentPhones) {
  if (this.activeJobCount > 0) break

  // Random delay between phone visits (human-like pacing)
  if (sentPhones.size > 1) {
    const interVisitDelay = 15000 + Math.random() * 30000 // 15-45s
    await sleep(interVisitDelay)
  }

  await this._withBrowserLock(async () => {
    // ... existing poll logic
  })
}
```

This prevents the telltale pattern of rapid-fire navigations to different phone numbers.

### 2.3 Adaptive Poll Intervals

**File:** `packages/worker/src/index.ts` (`getUnrepliedPhonesByAgent`)

Current: all phones polled every 60s regardless of age.

New: poll interval based on message age:

| Message Age | Poll Interval | Rationale |
|---|---|---|
| < 1 hour | 120s | Most replies arrive quickly |
| 1-4 hours | 300s (5 min) | Slower responders |
| 4-12 hours | 600s (10 min) | Late replies |
| 12+ hours | 1800s (30 min) | Very late — poll rarely |

**Implementation:**

```ts
function pollIntervalForMessage(sentAt: Date): number {
  const ageHours = (Date.now() - sentAt.getTime()) / (1000 * 60 * 60)
  if (ageHours < 1)  return 120_000
  if (ageHours < 4)  return 300_000
  if (ageHours < 12) return 600_000
  return 1_800_000
}
```

The `getUnrepliedPhonesByAgent()` function filters out phones whose poll interval hasn't elapsed yet, so only due phones are included in each batch.

### 2.4 Per-Phone Cooldown

Add a minimum cooldown to prevent re-visiting the same phone too often:

```ts
const PHONE_POLL_COOLDOWN_MS = 180_000 // 3 minutes
```

If a phone was polled less than 3 minutes ago, skip it even if its interval says it's due.

### 2.5 Resource Impact

With 7 agents:

| Metric | Before | After | Reduction |
|---|---|---|---|
| Phones per agent per cycle | 30 | 10 | 66% |
| Poll interval (avg) | 60s | 300s+ | 80%+ fewer cycles |
| Delay between visits | 0s | 15-45s | Spreads load |
| **Total navigations/min** | **~350** | **~15** | **~95%** |

The inter-visit delay means a 10-phone poll takes ~5-8 minutes instead of ~2 minutes, but since cycles run much less frequently (adaptive intervals), the overall CPU/DOM load drops dramatically.

---

## 3. Warm Day Tracking (Informational)

### 3.1 Database Changes

**File:** `packages/api/prisma/schema.prisma`

Add to `Agent` model:

```prisma
warmDaysCompleted  Int      @default(0)   // how many full warm sessions completed
restrictionCount   Int      @default(0)   // cumulative restriction count
lastRestrictedAt   DateTime?              // when the agent was last restricted
```

No fields on AppConfig — no enforcement, no gating.

### 3.2 Increment on Warm Session Complete

**File:** `packages/worker/src/lib/warm-worker.ts`

In `completeWarmSession()`, after setting `isWarmed = true`:

```ts
await db.agent.updateMany({
  where: { id: { in: sessionAgentIds } },
  data:  {
    isWarmed:          true,
    warmedAt:          new Date(),
    warmDaysCompleted: { increment: 1 },
  },
})
```

### 3.3 Advisory Display

The system calculates a **suggested** daily cap based on warm days (for display in the UI only):

| warmDaysCompleted | Advisory Multiplier | Suggested Cap (if cap=150) |
|---|---|---|
| 0 (unwarmed) | 0.10 | ~15 |
| 1 | 0.25 | ~37 |
| 2 | 0.50 | ~75 |
| 3 | 0.75 | ~112 |
| 4+ | 1.00 | 150 |

The agent's configured `dailySendCap` remains the actual limit. This is purely informational — shown in the agent card so you can decide whether to adjust the cap yourself.

### 3.4 Restriction Tracking

When a restriction is detected (e.g., `sendMessage` throws with a restriction-related error, or the agent status flips to QR unexpectedly while previously connected):

```ts
await db.agent.update({
  where: { id: agentId },
  data:  {
    restrictionCount: { increment: 1 },
    lastRestrictedAt:  new Date(),
  },
})
```

This is logged for visibility. No automatic action is taken.

---

## Environment Variables

Add to `.env.example`:

```env
# ─── Anti-Restriction: Navigation ─────────────────────────────────────────────
SIDEBAR_SEND_RATIO=0.70           # 0.0-1.0 — fraction of sends using sidebar search

# ─── Anti-Restriction: Reply Polling ──────────────────────────────────────────
REPLY_BATCH_SIZE=10               # max phones to poll per agent per cycle (was 30)
REPLY_POLL_COOLDOWN_MS=180000     # minimum time between polling the same phone (3 min)
POLL_INTER_VISIT_DELAY_MIN_MS=15000  # min delay between phone visits during poll
POLL_INTER_VISIT_DELAY_MAX_MS=45000  # max delay between phone visits during poll
```

---

## Files to Modify

| File | Change |
|---|---|
| `packages/api/prisma/schema.prisma` | Add `warmDaysCompleted`, `restrictionCount`, `lastRestrictedAt` to Agent |
| `packages/worker/src/lib/browser-agent.ts` | Add `sendMessageViaSidebar()`, inter-visit delays in `pollReplies` |
| `packages/worker/src/index.ts` | Mixed navigation, adaptive polling, per-phone cooldown |
| `packages/worker/src/lib/scheduler.ts` | Add `pollIntervalForMessage()` utility |
| `packages/worker/src/lib/warm-worker.ts` | Increment `warmDaysCompleted` on session completion |
| `.env.example` | Add new env vars |

---

## Implementation Order

1. `packages/api/prisma/schema.prisma` — add fields, run migration
2. `packages/worker/src/lib/browser-agent.ts` — add `sendMessageViaSidebar()`, inter-visit delays
3. `packages/worker/src/lib/scheduler.ts` — add `pollIntervalForMessage()`
4. `packages/worker/src/lib/warm-worker.ts` — increment `warmDaysCompleted`
5. `packages/worker/src/index.ts` — mixed navigation, adaptive polling, cooldown
6. `.env.example` — new env vars

---

## Rollback Plan

All changes are backward-compatible:

```env
# Revert to previous behavior
SIDEBAR_SEND_RATIO=0.0
REPLY_BATCH_SIZE=30
```

The new DB fields have defaults and don't affect existing logic. No data migration needed.
