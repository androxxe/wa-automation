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

## 2. Validasi WA Batch Size Modal with Multi-Area Selection

### 2.1 Motivation

Clicking "Validasi WA" currently queues every single unchecked contact at once.
For large contact lists this is undesirable — the user may only want to validate
a subset first to test agents or work in batches.

Additionally, users need to be able to select **specific areas** for validation
rather than always validating all areas. This is important for staged rollouts
or focusing validation on high-priority areas first.

### 2.2 API Endpoint — Unchecked Count with Per-Area Breakdown

File: `packages/api/src/routes/contacts.ts`

```
GET /api/contacts/validate-wa/count
```

Response:
```json
{
  "unchecked": 1240,
  "areaCount": 15,
  "areas": [
    { "areaId": "clx...", "name": "Aceh Barat", "contactType": "STIK", "unchecked": 80 },
    { "areaId": "clx...", "name": "Aceh Barat", "contactType": "KARDUS", "unchecked": 45 },
    ...
  ]
}
```

Query: Groups unchecked contacts by `areaId`, joins with area details for name
and contactType, sorted alphabetically by area name.

### 2.3 Updated Validate Endpoint

File: `packages/api/src/routes/contacts.ts`

`POST /api/contacts/validate-wa` — accepts multi-area selection and per-area
limit.

```ts
// Request body
{
  areaIds?: string[]      // array of area IDs to validate (new)
  areaId?: string         // legacy: single area ID (kept for backward compat)
  recheck?: boolean
  limit?: number          // global cap
  limitPerArea?: number   // per-area cap — takes priority over limit
}
```

When `areaIds` is provided, the query filters contacts to
`areaId: { in: areaIds }`. Falls back to `areaId` (single) if `areaIds` is
absent. When neither is provided, all areas are included.

The existing `limitPerArea` logic remains: groups contacts by area and takes at
most `limitPerArea` from each selected area before enqueuing.

### 2.4 Frontend — ValidasiModal Component

File: `packages/web/src/components/ValidasiModal.tsx`

Props:
```ts
interface ValidasiModalProps {
  open: boolean
  onClose: () => void
  onConfirm: (areaIds: string[], limitPerArea: number | null) => void
}
```

Behaviour:
- On mount (when `open = true`): fetches `GET /api/contacts/validate-wa/count`.
- Shows areas grouped by **contact type** (STIK section, KARDUS section).
- Each area has a checkbox + unchecked count. Areas with 0 unchecked are disabled.
- All areas with unchecked contacts are **selected by default**.
- Each group (STIK/KARDUS) has a "Pilih Semua / Hapus Semua" toggle.
- Search input filters areas by name across both groups.
- "Limit per area" number input (default: 60) with "Tanpa limit per area" checkbox.
- Bottom summary: total contacts to be queued across selected areas.
- Confirm button: "Mulai Validasi"
- Cancel button closes without firing.

```
┌─────────────────────────────────────────────┐
│  Validasi WA                                │
│                                             │
│  Limit per area: [  60  ]                   │
│  ☐ Tanpa limit per area                     │
│                                             │
│  [🔍 Cari area...]                          │
│                                             │
│  ── STIK ─── [Pilih Semua] ──────────────── │
│  ☑ Aceh Barat          80                   │
│  ☑ Aceh Timur          45                   │
│  ☐ Banda Aceh           0  (disabled)       │
│  ...                                        │
│                                             │
│  ── KARDUS ── [Pilih Semua] ─────────────── │
│  ☑ Aceh Barat          120                  │
│  ☐ Medan                30                  │
│  ...                                        │
│                                             │
│  Total: 325 nomor dari 3 area               │
│                                             │
│              [Batal]  [Mulai Validasi]       │
└─────────────────────────────────────────────┘
```

### 2.5 Frontend — Contacts Page Update

File: `packages/web/src/pages/Contacts.tsx`

- "Validasi WA" button sets `validasiModalOpen = true` instead of calling
  `validateMutation.mutate(false)` directly.
- `ValidasiModal` is rendered conditionally.
- `onConfirm(areaIds, limitPerArea)` calls
  `validateMutation.mutate({ recheck: false, limitPerArea, areaIds })`.
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
| 6 | `api` | Update `GET /api/contacts/validate-wa/count` to return per-area breakdown |
| 7 | `api` | Add `areaIds[]` + `limitPerArea` param support to `POST /api/contacts/validate-wa` |
| 8 | `web` | Add `validationOnly` toggle + badge to `Agents.tsx` |
| 9 | `web` | Redesign `ValidasiModal.tsx` with multi-area checkboxes grouped by STIK/KARDUS |
| 10 | `web` | Update `Contacts.tsx` to pass `areaIds` + `limitPerArea` from modal to mutation |

---

## 4. Constraints & Edge Cases

- **validationOnly + warmMode are mutually exclusive.** If `validationOnly = true`,
  `warmMode` is forced to `false` at save time (API + UI).
- **Limit exceeds unchecked count:** API clamps — if `limitPerArea > unchecked`
  in that area, all unchecked from that area are queued.
- **No validation agent online:** Phone-check falls back to a regular campaign
  agent so validation is never blocked.
- **Modal with 0 unchecked:** If unchecked count is 0, show a disabled state:
  `"Semua nomor sudah dicek"` and disable the confirm button.
- **"Cek Ulang Semua"** bypasses the modal entirely — it always re-checks
  everything regardless of this feature.
- **Multi-area selection:** All areas with unchecked contacts are selected by
  default when the modal opens. Areas with 0 unchecked are shown disabled.
- **Empty areaIds:** If no areas are selected, the confirm button is disabled.
  The API treats an empty `areaIds` array the same as omitting it (all areas).
- **Backward compatibility:** The `areaId` (single string) parameter is still
  supported for backward compatibility; `areaIds` takes priority when both are
  present.
- **Concurrent validation across agents:** The phone-check worker runs at
  `PHONE_CHECK_CONCURRENCY` (default 3). Each concurrent job independently picks
  an agent — validation-only agents preferred, fallback to campaign agents.
  Different agents operate fully in parallel; only operations within the same
  agent are serialized via `_withBrowserLock()`.

## 5. Concurrency Model

Multiple agents can validate phone numbers concurrently:

```
phoneCheckWorker (concurrency=3)
  ├─ Job 1 → getValidationAgent() → Agent A → checkPhoneRegistered()
  ├─ Job 2 → getValidationAgent() → Agent B → checkPhoneRegistered()
  └─ Job 3 → getValidationAgent() → Agent C → checkPhoneRegistered()
```

- Each `BrowserAgent` has `_withBrowserLock()` — a per-agent mutex that
  serializes all browser operations (send, check, poll) within that agent.
- Different agents have independent locks and operate fully in parallel.
- If fewer agents are online than `PHONE_CHECK_CONCURRENCY`, multiple jobs may
  queue behind the same agent's lock — no deadlock, just sequential processing.
- Agent selection uses `activeJobCount` to distribute load evenly.
