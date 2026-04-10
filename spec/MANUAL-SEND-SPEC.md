## Quick Send API (Manual Message) — Implementation Plan

### Goal
Enable sending a one-off WhatsApp text message via API without creating a campaign/queue entry, while keeping the auto-reply polling system intact.

### Scope
- Add `POST /api/messages/send` in API service.
- Add worker handler for manual-send commands over Redis pub/sub.
- Reuse existing BrowserAgent send logic; no UI work in this iteration (see Frontend entry points below for future).

### API Design
- **Endpoint:** `POST /api/messages/send`
- **Request body:**
  - `phone: string` (digits, allow leading +; normalized server-side)
  - `body: string` (required, max 2048 chars)
  - `agentId?: string` (optional explicit agent; must be online)
  - `dryRun?: boolean` (optional; validate/resolve agent only, no send)
  - `messageId?: string` (optional; tie to existing Message record for resend)
- **Responses:**
  - 202 `{ requestId, status: "queued", agentId? }` (always fire-and-forget)
  - 400 on validation errors; 409 when no agent available; 500 otherwise
- **Auth:** reuse existing auth middleware; apply lightweight rate limit (e.g., 30 req/min per user/IP) if available.
- **Validation:** mirror existing route pattern (zod/validator) for phone/body length and agent existence when provided.
### API Implementation Steps
1) Add route file or extend existing messages router under `packages/api/src/routes`.
2) Add request schema, normalization helper (strip spaces/+; enforce digits).
3) If `messageId` present: load message; reject if not found or already SENT/DELIVERED/READ; default `body` to message.body when omitted; require phone match.
4) Agent resolution: if `agentId` provided, verify online via Redis status; otherwise pick first available/idle agent (reuse existing status helper if present; otherwise new helper using Redis keys `agent:{id}:status`).
5) Publish command to Redis channel (see Worker changes) with payload `{ requestId, phone, body, agentId, requestedBy, dryRun, messageId }` (and optional campaignId/contactId if needed later).
5) Return 202 immediately (fire-and-forget); optional future endpoint could fetch status if persistence is added later.
6) Log audit event with `requestId`.
### Worker Changes
- Subscribe to Redis channel `manual-send:cmd`.
- On message:
  1. Validate payload; if `dryRun`, only resolve agent and emit `status: ok`.
  2. Acquire BrowserAgent via AgentManager using `agentId` (if provided) or availability selector (respect existing per-agent locks).
  3. Optionally bypass working-hours gate when `ALLOW_MANUAL_OUTSIDE_HOURS=true` (configurable; default false to reuse current guard).
  4. Send via `browserAgent.sendMessage` (prefer direct send path for lower latency; keep existing error handling for unregistered numbers, etc.).
  5. If `messageId` present and send succeeds: update that Message row to `status='SENT'`, set `sentAt=now`, `agentId` to sender, clear `failReason`, and update `body` if overridden.
  6. If `messageId` present and send fails: optionally set `status='FAILED'` with `failReason` (keep consistent with existing failure text style).
  7. Record minimal log/metric with `requestId` and result (sent/failed).
### Optional Persistence (Phase 2)
- Add `ManualMessage` table in Prisma for audit: `{ id, phone, body, agentId, status, error?, sentAt, createdBy, createdAt }`.
- API can upsert after worker response; not required for first iteration.

### Configuration
- `MANUAL_SEND_CHANNEL=manual-send:cmd`
- `ALLOW_MANUAL_OUTSIDE_HOURS=false`
- (Optional) rate-limit envs if not already present.

### Safety & Limits
- Enforce body length (2048) and text-only (no media/links filtering optional).
- Rate limit per user/IP to prevent spam bursts.
- Keep per-agent concurrency at 1 (existing lock).
- Respect working hours by default; configurable bypass flag.

### Observability
- Log with `requestId` in API and worker.
- Metrics: success/failure counters, agent selection distribution.

### Tests
- API unit/integration: validation failures, no-agent 409, happy path with mocked Redis publish, dryRun.
- Worker unit/integration: handles cmd, sends via BrowserAgent, propagates send errors, respects working-hours flag.

### Rollout
1) Implement API route + validation + pub/sub command publish helper.
2) Implement worker subscriber and sender flow.
3) Wire config/env defaults.
4) Add tests.
5) Document endpoint in README/API docs.

### Frontend Entry Points (UI plan)
- **Primary entry:** Campaign detail header (`pages/CampaignDetail.tsx`). Add a `Manual send` button alongside existing controls (Start/Pause/Retry). Opens a modal for one-off send; contextual for operators already working a campaign.
- **Secondary entry (nice-to-have):** Contacts list (`pages/Contacts.tsx`) row action “Send one-off” that opens the same modal with phone prefilled from the contact.
- **Message-level action:** In Campaign Detail message table, add “Manual send” on rows with statuses eligible for resend (FAILED/QUEUED/EXPIRED/CANCELLED as decided). Opens modal prefilled with that message’s phone/body and passes `messageId` so status updates to `SENT` on success.

### Manual Send Modal (shared component)
- Placement: co-located in `CampaignDetail.tsx` (similar to existing `EnqueueModal` inline component). Reusable prop to accept optional prefilled phone.
- Fields:
  - Phone (text, prefilled if available). Client-side normalize: strip spaces/+ on blur; show helper text “Digits only, include country code”.
  - Body (textarea, required, max 2048 chars) prefilled with the campaign template (placeholders intact) when opened from header; when opened from a message row, prefill with that message body; editable; live character counter.
  - Agent (select, optional). Populate from `/api/agents` (existing Agents page already fetches list). Show status badge; offline agents visible but disabled (manual send requires online agent).
  - Note: inline hint that this bypasses campaign scheduling/queue.
- Validation UX: disable submit when phone/body invalid; show inline error text under fields. Keep consistent styling with existing inputs (Tailwind borders, rounded-md, text-sm).
- Submit behavior:
  - POST `/api/messages/send` with `{ phone, body, agentId?, messageId? }` (fire-and-forget 202).
  - While pending: disable form + show "Sending…" label.
  - On success (202): close modal and surface confirmation (`alert` for consistency with current UX) showing requestId and chosen agent.
  - On 400/409: keep modal open; render error banner at top.
- Loading: show small inline spinner in the submit button when pending.
- Accessibility: Close on overlay click/X button and Esc key (match `FailReasonModal` / `EnqueueModal` patterns).

### UI Wiring in CampaignDetail
- Add a `Manual send` button in Controls section (enabled when campaign not CANCELLED). Clicking sets `manualModalOpen=true`.
- Render `<ManualSendModal onClose=... prefilledPhone={undefined} />` when open from header.
- Add per-row “Manual send” action for eligible statuses; opens the same modal with `prefilledPhone`, `prefilledBody`, and passes `messageId`.
- Use `useMutation` (tanstack query) for the POST call; reuse `apiFetch` helper.
- Optionally invalidate `['campaign-messages', id]` after send so the message row reflects `SENT` when tied to a `messageId`.

### UI Wiring in Contacts (optional later)
- Add per-row action “Send one-off” that opens the same modal with `prefilledPhone` from contact. No campaign context needed.

### Visual direction
- Follow existing card/modal styling (rounded, border, bg-background, text-sm). Use compact layout similar to `EnqueueModal` to stay consistent with current tailwind design.
