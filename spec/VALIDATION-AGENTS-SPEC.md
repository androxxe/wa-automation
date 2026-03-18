# Validation Agents & Validasi WA Batch Control — Spec

## Overview

Two related features:

1. **Validation-Only Agents** — A new agent mode where an agent is exclusively
   reserved for `phone-check` (Validasi WA) jobs and is never assigned campaign
   sends.

2. **Validasi WA Batch Size Modal** — When the user clicks "Validasi WA" on the
   Contacts page, a modal appears asking how many unchecked numbers to queue
   for validation instead of immediately queueing all of them.

---

## 1. Validation-Only Agents

### 1.1 Motivation

Currently all online agents share both the `whatsapp-messages` (campaign) queue
and the `phone-check` (validation) queue. This means:

- A campaign agent that is mid-session can be interrupted by phone-check jobs.
- There is no way to dedicate accounts purely to validation work (which is safer
  and lower-risk than mass sending).

### 1.2 Agent Model Change

Add a `validationOnly` boolean field to the `Agent` Prisma model.

```prisma
// packages/api/prisma/schema.prisma
model Agent {
  // ... existing fields ...
  validationOnly Boolean @default(false)
}
```

Migration: `prisma migrate dev --name add-validation-only-agent`

### 1.3 AgentManager Logic

File: `packages/worker/src/lib/agent-manager.ts`

**New method: `getValidationAgent()`**
- Returns the online `BrowserAgent` with the lowest `activeJobCount` among
  agents where `validationOnly = true`.
- Returns `null` if no validation-only agent is online.

**Updated method: `getLeastBusyAgent()`**
- Adds an exclusion filter: skip agents where `validationOnly = true`.
- Campaign sends will never land on a validation-only agent.

```
getValidationAgent()
  → filter: agent.validationOnly === true && status === ONLINE
  → sort by activeJobCount ASC
  → return first or null

getLeastBusyAgent()  (updated)
  → filter: agent.validationOnly === false && status === ONLINE
  → sort by activeJobCount ASC
  → return first or null
```

### 1.4 Phone-Check Worker Logic

File: `packages/worker/src/index.ts` (phoneCheckWorker)

Replace the current `getLeastBusyAgent()` call with:

```ts
const agent =
  agentManager.getValidationAgent() ??
  agentManager.getLeastBusyAgent()
```

Fallback to a regular campaign agent only when no validation-only agent is
online, ensuring validation work is never blocked.

### 1.5 API Routes

File: `packages/api/src/routes/agents.ts`

- `POST /api/agents` — accept `validationOnly?: boolean` in request body,
  default `false`.
- `PATCH /api/agents/:id` — accept `validationOnly?: boolean`, persist to DB.

### 1.6 Frontend — Agents Page

File: `packages/web/src/pages/Agents.tsx`

**Agent card badge:**
- When `validationOnly = true`, render a purple pill badge `Validation` next to
  the agent name (similar pattern to the `warmMode` badge if one exists, or
  following the status badge pattern).

**Agent edit modal:**
- Add a toggle row "Hanya untuk validasi" below the existing "Warm Mode" toggle.
- When enabled, the agent is flagged as validation-only.
- When enabled, the warm mode toggle should be disabled (these modes are mutually
  exclusive — a validation agent never sends messages, so warming is irrelevant).

**Badge appearance:**
```
[ • ] Agent Name   [Validation]   [ONLINE]
```
Badge: `bg-purple-100 text-purple-700 text-xs font-medium px-2 py-0.5 rounded-full`

---

## 2. Validasi WA Batch Size Modal

### 2.1 Motivation

Clicking "Validasi WA" currently queues every single unchecked contact at once.
For large contact lists this is undesirable — the user may only want to validate
a subset first to test agents or work in batches.

### 2.2 New API Endpoint — Unchecked Count

File: `packages/api/src/routes/contacts.ts`

```
GET /api/contacts/validate-wa/count
```

Response:
```json
{ "unchecked": 1240 }
```

Query:
```ts
const count = await db.contact.count({
  where: { phoneValid: true, waChecked: false }
})
```

### 2.3 Updated Validate Endpoint

File: `packages/api/src/routes/contacts.ts`

`POST /api/contacts/validate-wa` — add optional `limit` to the request body.

```ts
// Request body
{ forceRecheck?: boolean, limit?: number }

// When limit is provided:
const contacts = await db.contact.findMany({
  where: { phoneValid: true, waChecked: false },
  orderBy: { id: 'asc' },
  take: limit,         // only queue first N unchecked contacts
})
```

When `limit` is absent or `0`, behaviour is unchanged (queue all unchecked, or
all contacts when `forceRecheck = true`).

### 2.4 Frontend — ValidasiModal Component

**New file:** `packages/web/src/components/ValidasiModal.tsx`

Props:
```ts
interface ValidasiModalProps {
  open: boolean
  onClose: () => void
  onConfirm: (limit: number | null) => void  // null = validate all
}
```

Behaviour:
- On mount (when `open = true`): fetches `GET /api/contacts/validate-wa/count`.
- Shows unchecked count as hint text: `"1.240 nomor belum dicek"`
- Number `<input>` pre-filled with the unchecked count.
- User can change the number to any value between `1` and unchecked count.
- "Validasi Semua" link below input resets it to the full unchecked count.
- Confirm button: "Mulai Validasi"
- Cancel button closes without firing.

```
┌─────────────────────────────────────────┐
│  Validasi WA                            │
│                                         │
│  Berapa nomor yang ingin divalidasi?    │
│                                         │
│  ┌────────────────────────┐             │
│  │  100                   │             │
│  └────────────────────────┘             │
│  1.240 nomor belum dicek · Validasi     │
│  Semua                                  │
│                                         │
│              [Batal]  [Mulai Validasi]  │
└─────────────────────────────────────────┘
```

### 2.5 Frontend — Contacts Page Update

File: `packages/web/src/pages/Contacts.tsx`

- "Validasi WA" button sets `validasiModalOpen = true` instead of calling
  `validateMutation.mutate(false)` directly.
- `ValidasiModal` is rendered conditionally.
- `onConfirm(limit)` calls `validateMutation.mutate({ forceRecheck: false, limit })`.
- "Cek Ulang Semua" button is unchanged (no modal, re-checks everything).

---

## 3. Implementation Steps

| Step | Package | Task |
|------|---------|------|
| 1 | `api` | Add `validationOnly` to Prisma schema + run migration |
| 2 | `worker` | Add `getValidationAgent()` to `AgentManager` |
| 3 | `worker` | Update `getLeastBusyAgent()` to exclude validation-only agents |
| 4 | `worker` | Update `phoneCheckWorker` to call `getValidationAgent()` with fallback |
| 5 | `api` | Handle `validationOnly` in agents `POST` + `PATCH` routes |
| 6 | `api` | Add `GET /api/contacts/validate-wa/count` endpoint |
| 7 | `api` | Add `limit` param support to `POST /api/contacts/validate-wa` |
| 8 | `web` | Add `validationOnly` toggle + badge to `Agents.tsx` |
| 9 | `web` | Create `ValidasiModal.tsx` component |
| 10 | `web` | Update `Contacts.tsx` to open modal instead of direct validate call |

---

## 4. Constraints & Edge Cases

- **validationOnly + warmMode are mutually exclusive.** If `validationOnly = true`,
  `warmMode` is forced to `false` at save time (API + UI).
- **Limit exceeds unchecked count:** API clamps — if `limit > unchecked`, all
  unchecked are queued (same as no limit).
- **No validation agent online:** Phone-check falls back to a regular campaign
  agent so validation is never blocked.
- **Modal with 0 unchecked:** If unchecked count is 0, show a disabled state:
  `"Semua nomor sudah dicek"` and disable the confirm button.
- **"Cek Ulang Semua"** bypasses the modal entirely — it always re-checks
  everything regardless of this feature.
