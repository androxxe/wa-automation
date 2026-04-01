# Performance Optimizations — TODO

Remaining optimizations not yet implemented (medium/low priority).

## Medium Priority

### 1. Reduce Per-Phone Poll Overhead
**File:** `packages/worker/src/lib/browser-agent.ts:389`

- Reduce the 1.5s `waitForTimeout` after chat loads to 500ms (just need DOM to settle for reading)
- For poll-only: instead of waiting for compose box (20s timeout), wait for any message row (`[data-id]`, `.message-in`, `.message-out`) to appear — faster signal that chat content has loaded since we don't need to type anything

**Expected impact:** Per-phone poll time drops from ~5-10s to ~3-5s.

### 2. Tune Polling Config in `.env.prod`
Current → Suggested values:

| Param | Current | Suggested | Reason |
|---|---|---|---|
| `REPLY_BATCH_SIZE` | 20 | 40-50 | More phones checked per cycle |
| `REPLY_REPOLL_COOLDOWN_MS` | 900000 (15 min) | 600000 (10 min) | Faster re-check of phones |
| `REPLY_POLL_INTERVAL_MS` | 480000 (8 min) | 300000 (5 min) | Cycles are now faster with parallel agents |

## Low Priority

### 3. Reduce Keystroke Delays
**File:** `.env.prod` or per-agent DB override

Current: `TYPE_DELAY_MIN_MS=80`, `TYPE_DELAY_MAX_MS=180` (16-36s for 200 chars)
Suggested: `TYPE_DELAY_MIN_MS=40`, `TYPE_DELAY_MAX_MS=100` (8-20s for 200 chars)

**Expected impact:** ~50% faster typing per message.

### 4. Batch `todaySendCount` DB Query
**File:** `packages/worker/src/index.ts:38-42, 127-131`

Currently runs one `db.dailySendLog.findUnique()` per candidate agent (up to 6 sequential queries).
Replace with a single `db.dailySendLog.findMany()` for all agent IDs, then look up from a Map.

```ts
// Before (N sequential queries):
for (let i = 0; i < online.length; i++) {
  const sent = await todaySendCount(candidate.agentId)
}

// After (1 query):
const today = new Date().toISOString().slice(0, 10)
const logs = await db.dailySendLog.findMany({
  where: { date: today, agentId: { in: online.map(o => o.agentId) } },
})
const countMap = new Map(logs.map(l => [l.agentId, l.count]))
// Then: const sent = countMap.get(candidate.agentId) ?? 0
```

**Expected impact:** Eliminates ~5 extra DB round-trips per message job.

### 5. Skip Report Regeneration on Every Send
**File:** `packages/worker/src/index.ts:213-221`

Every successful send triggers `POST /api/export/report-area` which rebuilds the entire CSV. Consider:
- Debounce: only regenerate every N sends or every M seconds
- Move to a background job instead of fire-and-forget HTTP

### 6. Optimize Enqueue Bulk Insert
**File:** `packages/api/src/routes/campaigns.ts:296-304`

Replace sequential `db.message.create()` calls with `db.message.createMany()` for batch insertion.
With hundreds of contacts, this reduces hundreds of MySQL INSERTs to one.

### 7. Add MySQL Indexes
**File:** `packages/api/prisma/schema.prisma`

Consider adding:
- `@@index([status, campaignId])` on Message
- `@@index([phone, status])` on Message
- `@@index([agentId, status])` on Message

These could speed up the `getUnrepliedPhonesByAgent()` and `handleReply()` queries significantly with thousands of messages.
