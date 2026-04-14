# Invalid Answer Marking — Business Flow Specification

## Overview

This spec defines the workflow for **marking reply answers as invalid** when they don't meet quality standards. Some replies may be incorrectly analyzed by Claude or manually collected with invalid/inaccurate data, so operators need a way to flag these and exclude them from reports.

---

## Problem Statement

- **Current state**: Replies can be manually corrected via PATCH `/api/replies/:id` to adjust `claudeCategory` or `jawaban` (1 = yes, 0 = no, null = unclear)
- **Gap**: No way to mark an answer as "invalid" (distinct from `unclear`/`null`). Operators need to exclude bad data from XLSX exports and reports without permanently deleting the record.
- **Goal**: Provide UI action in CampaignDetail.tsx to mark replies as invalid, then include that status in XLSX exports.

---

## Proposed Solution

### Option A: Reuse existing fields (RECOMMENDED — Zero Breaking Changes)

**No DB schema change needed! Use existing fields:**
```
When marked invalid:
  claudeCategory = 'invalid'     // NEW category type
  jawaban = null                 // Clear the answer
  
When valid:
  claudeCategory = 'confirmed' | 'denied' | 'question' | 'unclear' | 'other'
  jawaban = 1 | 0 | null
```

**Advantages:**
- ✅ **Zero DB migration required** — leverage existing fields
- ✅ No schema breaking changes
- ✅ Backward compatible with existing code
- ✅ Easy to filter: `WHERE claudeCategory='invalid'`
- ✅ Clear semantics: category='invalid' means the answer is unreliable
- ✅ Easy to reverse: change category back + restore jawaban
- ✅ Works with existing PATCH `/api/replies/:id` endpoint

**Disadvantages:**
- Slightly overloads the `claudeCategory` field semantics (but acceptable)

---

### Option B: Add `invalid` field (More explicit but needs migration)

**Requires DB migration:**
```prisma
invalid: Boolean @default(false)
invalidReason: String?
invalidatedBy: String?
invalidatedAt: DateTime?
```

**Advantages:**
- More explicit semantics
- Allows tracking who/when

**Disadvantages:**
- ❌ Requires DB migration
- ❌ More code changes
- ❌ Additional DB schema complexity

---

## **Recommendation: Use Option A** (Reuse existing fields)

---

## Implementation Workflow

### 1. No Database Migration Needed ✅

Use existing `claudeCategory` and `jawaban` fields only.

### 2. Update Type Definition in Shared Types

Update `packages/shared/src/index.ts`:
```typescript
export type ReplyCategory  = 'confirmed' | 'denied' | 'question' | 'unclear' | 'invalid' | 'other'
//                                                                    ^^^^^^^^^ ADD THIS
```

### 3. Backend API Changes

**Update PATCH `/api/replies/:id` to accept `invalid` action:**

```typescript
// POST body:
{
  category?: string | null,           // e.g., 'confirmed', 'denied', 'invalid', etc.
  jawaban?: 1 | 0 | null
}

// Special case: Mark as invalid
// PATCH /api/replies/:id { category: 'invalid', jawaban: null }
```

**Update GET `/api/replies` to include `invalid` status in response:**
- Return `claudeCategory: 'invalid'` in reply objects
- Filter by category: `?category=invalid` already works
- Stats: Add `invalid` count alongside `confirmed`, `denied`, `question`, `unclear`, `other`

```typescript
// Stats response example:
{
  total: 100,
  confirmed: 45,
  denied: 30,
  question: 10,
  unclear: 5,
  invalid: 10,      // NEW: replies with claudeCategory='invalid'
  other: 0
}
```

### 4. Frontend UI Changes

**In CampaignDetail.tsx message table:**
- Add "Mark Invalid" button next to "Retry", "Manual send", "Cancel"
- Add screenshot icon button (similar to Responses.tsx) to view reply screenshot if available
- When "Mark Invalid" clicked: PATCH `/api/replies/:id` with `{ category: 'invalid', jawaban: null }`
- Show confirmation modal (optional)
- Style the invalid reply row with muted/strikethrough appearance

**Screenshot Modal** (reuse from Responses.tsx):
- Click image icon → Opens full-screen dark modal with screenshot
- Press Escape or click background to close
- URL: `/api/replies/screenshot?p=${encodeURIComponent(screenshotPath)}`

**UI mockup:**
```
| Status | Reply Text | Screenshot | Actions |
|--------|-----------|------------|---------|
| READ   | "Yes"     | [🖼 icon]  | [Retry] [Manual send] [Mark Invalid ✕] |
         (clickable image icon shows screenshot in modal)
         
| INVALID| "No"      | [🖼 icon]  | (muted appearance, strikethrough text)
         Marked as invalid
```

**Code reference for screenshot button:**
- Image icon button: `Responses.tsx:604-623`
- Screenshot modal: `Responses.tsx:87-120`

### 5. XLSX Export Update

**In `packages/api/src/lib/report-xlsx.ts` or `exporter.ts`:**
- **Include all replies** (both valid and invalid)
- Add visual indicator for invalid replies:
  - **Background color**: Light red/gray fill for rows with `claudeCategory='invalid'`
  - **Status column**: Add "Status" column showing:
    - `"Valid"` for normal replies
    - `"⚠ Invalid"` for invalid replies (with strikethrough text)
  - **Footer**: Count summary: "Total: 100 | Valid: 90 | Invalid: 10"

**SQL Query:**
```sql
SELECT * FROM Reply 
WHERE messageId IN (...)
ORDER BY claudeCategory DESC  -- Invalid rows shown last/highlighted
```

**XLSX Structure:**
```
| Phone | Store | Reply | Category | Jawaban | Status | Notes |
|-------|-------|-------|----------|---------|--------|-------|
| 62811 | Store1| "Yes" | confirmed| 1       | Valid  | ✓     |
| 62812 | Store2| "Maybe"| unclear | null    | Valid  | —     |
| 62813 | Store3| "No"  | invalid  | null    | ⚠ Invalid| Marked invalid |
| 62814 | Store4| "Yes" | denied   | 0       | Valid  | ✓     |
```

**CSV Report update:**
- Include all rows (valid + invalid)
- Append status indicator: "Status" column with "Valid" or "Invalid"
- Footer summary: "Total exported: 100 (Valid: 90, Invalid: 10)"

---

## Data Flow Diagram

```
User in CampaignDetail.tsx
         |
         v
    [Click "Mark Invalid"]
         |
         v
   Confirm modal (optional)
         |
         v
   PATCH /api/replies/:id { 
     category: 'invalid',
     jawaban: null 
   }
         |
         v
   Backend updates DB:
   claudeCategory='invalid', jawaban=null
         |
         v
   Frontend refreshes messages list
         |
         v
   Reply appears with muted/strikethrough style
   "Marked as invalid"

Later: XLSX export
         |
         v
   Query: SELECT * FROM Reply WHERE messageId IN (...)
          (includes both valid AND invalid)
         |
         v
   Format with visual indicators:
   - Background color for invalid rows
   - Status column: "Valid" or "⚠ Invalid"
   - Footer summary: "Valid: 90, Invalid: 10"
         |
         v
   Export to XLSX (all replies visible, invalid marked)
```

---

## API Contract

### PATCH /api/replies/:id
**Request to mark as invalid:**
```json
{
  "category": "invalid",
  "jawaban": null
}
```

**Request to correct/unmark:**
```json
{
  "category": "confirmed",
  "jawaban": 1
}
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "id": "...",
    "body": "...",
    "claudeCategory": "invalid",
    "jawaban": null,
    "receivedAt": "2026-04-14T10:30:00Z"
  }
}
```

### GET /api/replies
**Filter by invalid:**
```
GET /api/replies?campaignId=...&category=invalid
```

**Response includes stats:**
```json
{
  "ok": true,
  "data": {
    "replies": [...],
    "total": 100,
    "stats": {
      "total": 100,
      "confirmed": 45,
      "denied": 30,
      "question": 10,
      "unclear": 5,
      "invalid": 10,
      "other": 0
    }
  }
}
```

---

## Rollout Plan

1. **Phase 1** (10 min): Update shared types — add `'invalid'` to ReplyCategory
2. **Phase 2** (15 min): Update backend PATCH `/api/replies/:id` — accept category='invalid' + jawaban=null
3. **Phase 3** (15 min): Update stats in GET `/api/replies` — count invalid category
4. **Phase 4** (30 min): Frontend UI — add "Mark Invalid" button in CampaignDetail.tsx
5. **Phase 5** (30 min): Update XLSX export — include invalid replies with visual indicators (color + status column + footer summary)
6. **Phase 6** (Testing & docs)

**Total time: ~100 minutes, zero breaking changes**

---

## Summary of Changes

| Component | Change | Effort |
|-----------|--------|--------|
| Shared types | Add `'invalid'` to ReplyCategory | 1 line |
| Backend PATCH | No change needed — already supports category + jawaban | 0 |
| Backend GET | Add `invalid` to stats count | 5 lines |
| Frontend | Add "Mark Invalid" button + screenshot icon + modal in CampaignDetail.tsx | 50 lines |
| XLSX export | Include all replies + add status column + visual indicators + footer summary | 40 lines |
| Database | **None** — use existing fields | 0 |

**Grand total: ~96 lines of code, zero DB migrations, zero breaking changes**

**Reusable components from Responses.tsx:**
- ScreenshotModal component (lines 87-120)
- Screenshot button icon (lines 604-623)
- Modal state management pattern

---

## Future Enhancements

- Bulk "Mark Invalid" action (select multiple replies)
- Dashboard widget showing invalid reply trends
- Auto-flag based on sentiment/keyword patterns
- Revalidation workflow (allow operator to re-analyze previously invalid replies)
- Audit log: track who marked as invalid and when (via timestamps if needed)
