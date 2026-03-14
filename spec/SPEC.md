# AICE WhatsApp Automation — Project Specification

## Overview

A full-stack web application for managing bulk WhatsApp messaging campaigns targeting AICE ice cream distribution partners. Reads contact data from `.xlsx` files organized by department and market area, sends personalized WhatsApp messages via a real visible Chromium browser controlled by Playwright (mimicking genuine human interaction to minimize ban risk), captures replies via DOM polling, analyzes them with Claude AI, writes results back to output Excel files, and auto-generates per-area CSV reports with binary confirmation answers (1 = confirmed, 0 = denied).

---

## Tech Stack

| Layer | Library/Tool | Version | Notes |
|---|---|---|---|
| Monorepo | pnpm workspaces | latest | 4 packages: shared, api, worker, web |
| API server | Express.js + TypeScript | latest | REST + SSE |
| Frontend | React + Vite + Tailwind CSS | latest | Port 5173 |
| Browser Automation | playwright | latest | Controls real visible Chromium window |
| Anti-Detection | Custom stealth init script | — | Removes headless/automation fingerprints via `addInitScript` |
| Excel Parsing | xlsx (SheetJS) | latest | Read `.xlsx`, inconsistent headers |
| AI | @anthropic-ai/sdk | latest | Header mapping, reply analysis, message variation |
| Queue | bullmq + ioredis | latest | Durable rate-limited message queue |
| Database | Prisma + MySQL | latest | Requires running MySQL instance |
| Realtime | Server-Sent Events (SSE) | — | Express native, no socket.io |
| Language | TypeScript | latest | Strict mode |
| Runtime | Node.js 20+ | — | |

---

## Monorepo Structure

```
whatsapp-automation/
├── packages/
│   ├── shared/          # TypeScript types only — no runtime deps
│   ├── api/             # Express.js server + all server-side lib + Prisma
│   ├── worker/          # BullMQ worker — owns the Playwright browser
│   └── web/             # React + Vite frontend
├── .env                 # Single env file for all packages
├── .env.example
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── spec/SPEC.md
```

### Package responsibilities

| Package | Responsibility |
|---|---|
| `@aice/shared` | Shared TypeScript interfaces (MessageJob, PhoneCheckJob, CampaignStatus, SSE event types, etc.) |
| `@aice/api` | Express routes, lib utilities (excel, phone, claude, queue producer, exporter, report), Prisma schema |
| `@aice/worker` | BullMQ consumers (message + phone-check), BrowserManager singleton, scheduler, Claude variation |
| `@aice/web` | React SPA — all UI pages, Vite proxy to API |

> **BrowserManager ownership**: The Playwright browser runs inside `@aice/worker`. The API reads browser status from Redis. Browser control commands (start/stop) are sent via Redis pub/sub from API → worker.

---

## Environment Variables (`.env`)

```env
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Data paths
DATA_FOLDER=/absolute/path/to/data          # root folder containing Department 1..9
OUTPUT_FOLDER=/absolute/path/to/output      # where response files are written

# Database
DATABASE_URL=mysql://root@localhost:3306/wa_automation

# Redis
REDIS_URL=redis://localhost:6379

# Browser automation
BROWSER_PROFILE_PATH=./browser-profile      # persistent Chromium user data dir
BROWSER_HEADLESS=false                      # always false — visible window required

# Working hours (WIB = Asia/Jakarta, UTC+7)
WORKING_HOURS_START=08:00
WORKING_HOURS_END=17:00
WORKING_DAYS=1,2,3,4,5,6                   # 1=Monday … 7=Sunday
TIMEZONE=Asia/Jakarta

# Rate limiting (Gaussian distribution — not mechanical fixed interval)
RATE_LIMIT_MEAN_MS=35000                    # mean 35 seconds between messages
RATE_LIMIT_STDDEV_MS=8000                   # std deviation ±8 seconds
RATE_LIMIT_MIN_MS=20000                     # hard floor — never faster than 20s
RATE_LIMIT_MAX_MS=90000                     # hard ceiling — never slower than 90s

# Safety caps
DAILY_SEND_CAP=150                          # max messages per day
MID_SESSION_BREAK_EVERY=30                  # pause after every N messages
MID_SESSION_BREAK_MIN_MS=180000             # min break duration (3 min)
MID_SESSION_BREAK_MAX_MS=480000             # max break duration (8 min)

# Reply polling
REPLY_POLL_INTERVAL_MS=60000               # scan WA Web for new replies every 60s

# API server
PORT=3001

# Web (Vite — must be prefixed VITE_)
VITE_API_URL=http://localhost:3001
```

### Startup Validation

Both `@aice/api` and `@aice/worker` run a startup validation before accepting traffic:

1. **Environment variables** — checks all required vars are present and not placeholder values
2. **ANTHROPIC_API_KEY format** — must start with `sk-ant-`
3. **DATABASE_URL format** — must start with `mysql://`
4. **MySQL connection** — `SELECT 1` query
5. **Redis connection** — `PING`
6. **DATA_FOLDER exists** (API only)

Process exits with code 1 and a clear error summary if any check fails.

---

## Data Source Structure

```
data/
├── Department 1/
│   ├── Aceh Barat.xlsx
│   ├── Aceh Utara.xlsx
│   └── ...
├── Department 2/
│   └── ...
...
└── Department 9/
    └── ...
```

### Excel File Format (sample)

Bilingual headers (Chinese/Indonesian), inconsistent across files but semantically consistent:

| Sample Header | Internal Field |
|---|---|
| `序号\nNo` | `seq_no` |
| `终端名称\nNama toko` | `store_name` |
| `冰柜编号\nIDN Freezer` | `freezer_id` |
| `电话号码\nNo hp` | `phone` |
| `Jumlah Penukaran (Stik)` | `exchange_count` |
| `Jumlah Stik Berhadiah (Stik)` | `award_count` |
| `Total Jumlah (Stik)` | `total_count` |

Column mapping is **AI-assisted**: Claude receives the raw headers + 2 sample rows and returns a JSON mapping. User confirms before import. Mapping is saved per area file and reused on subsequent imports.

---

## Phone Number Normalization

Indonesian mobile numbers are normalized to E.164 format for WhatsApp. All formats commonly found in xlsx files are handled:

| Input | Normalized | Note |
|---|---|---|
| `08121234567` | `+628121234567` | Standard local format |
| `8121234567` | `+628121234567` | Excel stripped leading zero (numeric cell) |
| `628121234567` | `+628121234567` | Country code without `+` |
| `+628121234567` | `+628121234567` | Already E.164 |
| `8.21167464117E+11` | `+62821167464117` | Excel scientific notation |
| `0821 1674 6411` | `+628211674641` | Spaces stripped |
| `0821-1674-6411` | `+628211674641` | Dashes stripped |

**Rules (applied in order):**
1. Detect and parse scientific notation (e.g. `8.12E+10`) before any other processing
2. Strip all non-digit characters (spaces, dashes, parentheses, dots)
3. If starts with `0` → replace with `62`
4. If starts with `8` → prepend `62` (Excel dropped leading zero)
5. If starts with `62` → keep as-is, prepend `+`
6. Validate: after `+62`, remaining digits must be 8–12 digits
7. Invalid numbers stored with `phoneValid = false`, `waChecked = true` — excluded from queue

---

## WhatsApp Registration Validation

Format-valid phones are not guaranteed to be registered on WhatsApp. A separate WA check step is required before sending.

### Contact WA Status (3 states)

| `phoneValid` | `waChecked` | UI Badge | Meaning |
|---|---|---|---|
| `true` | `false` | Gray — **Belum dicek** | Format OK, not yet checked against WA |
| `true` | `true` | Green — **Terdaftar** | Confirmed registered on WhatsApp |
| `false` | any | Red — **Tidak valid** | Bad format OR not registered on WA |

### Check logic (`checkPhoneRegistered`)

Uses `Promise.race` between two Playwright signals after navigating to `https://web.whatsapp.com/send?phone={number}`:

```
Race:
  compose box appears (within 20s)  → registered  (true)
  popup appears     (within 20s)  → not registered (false)
  both timeout                    → treat as registered (safe fallback)
```

If popup appears, it is **dismissed** (button clicked) before returning, so it never blocks the next navigation.

### Automatic invalidation during send

If `sendMessage` encounters the "Nomor tidak terdaftar" popup during a live campaign, the worker:
1. Dismisses the popup
2. Marks `message.status = FAILED` with `failReason`
3. **Also** updates the contact: `phoneValid = false, waChecked = true`

This ensures the contact is excluded from all future campaigns without needing a manual re-validation.

### Browser lock

All browser operations (`sendMessage`, `checkPhoneRegistered`, `pollReplies`) are serialised through a `_withBrowserLock` mutex on `BrowserManager`, preventing the message-send worker and phone-check worker from colliding on the same Playwright page.

---

## Message Template

Static per-campaign template with variable substitution. Variables use `{{variable_name}}` syntax.

### Default Template

```
Halo bapak/ibu mitra aice {{area}} toko {{nama_toko}}, saya dari tim inspeksi aice pusat Jakarta ingin melakukan konfirmasi. Apakah benar bahwa pada bulan {{bulan}} toko bapak/ibu telah melakukan penukaran Stick ke distributor?
```

### Available Variables

| Variable | Source |
|---|---|
| `{{nama_toko}}` | `store_name` from Excel |
| `{{bulan}}` | Campaign-level static field (user sets once, e.g. `"12"` or `"Desember"`) |
| `{{department}}` | Department name |
| `{{area}}` | Area / market name |

### Message Variation (Claude Job 3)

Before each message is sent, Claude subtly varies the wording so no two outgoing messages are byte-identical. The meaning and all variables remain exactly the same — only minor surface-level phrasing changes (punctuation, word order, synonym swaps). This prevents WhatsApp's identical-content detection from flagging bulk sends.

```
Input:  rendered template string
Output: slightly rephrased version (still natural Indonesian)
```

---

## Database Schema (Prisma + MySQL)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

model Department {
  id        String    @id @default(cuid())
  name      String    @unique
  path      String    @db.VarChar(500)
  areas     Area[]
  contacts  Contact[]
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}

model Area {
  id            String         @id @default(cuid())
  name          String
  fileName      String
  filePath      String         @db.VarChar(500)
  columnMapping Json?                          // Claude-mapped column keys
  departmentId  String
  department    Department     @relation(fields: [departmentId], references: [id], onDelete: Cascade)
  contacts      Contact[]
  campaigns     CampaignArea[]
  createdAt     DateTime       @default(now())
  updatedAt     DateTime       @updatedAt

  @@unique([departmentId, name])
}

model Contact {
  id            String     @id @default(cuid())
  seqNo         String?
  storeName     String
  freezerId     String?
  phoneRaw      String
  phoneNorm     String
  phoneValid    Boolean    @default(true)   // false = bad format OR not on WA
  waChecked     Boolean    @default(false)  // true = has been validated against WA Web
  exchangeCount Int?
  awardCount    Int?
  totalCount    Int?
  areaId        String
  area          Area       @relation(fields: [areaId], references: [id], onDelete: Cascade)
  departmentId  String
  department    Department @relation(fields: [departmentId], references: [id], onDelete: Cascade)
  messages      Message[]
  createdAt     DateTime   @default(now())
  updatedAt     DateTime   @updatedAt

  @@unique([areaId, phoneNorm])
}

model Campaign {
  id             String         @id @default(cuid())
  name           String
  template       String         @db.Text
  bulan          String
  status         String         @default("DRAFT") // DRAFT|RUNNING|PAUSED|COMPLETED|CANCELLED
  areas          CampaignArea[]
  messages       Message[]
  totalCount     Int                  @default(0)
  sentCount      Int                  @default(0)
  deliveredCount Int                  @default(0)
  readCount      Int                  @default(0)
  failedCount    Int                  @default(0)
  replyCount     Int                  @default(0)
  scheduledAt    DateTime?
  startedAt      DateTime?
  completedAt    DateTime?
  createdAt      DateTime             @default(now())
  updatedAt      DateTime             @updatedAt
}

model CampaignArea {
  campaignId String
  areaId     String
  campaign   Campaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  area       Area     @relation(fields: [areaId], references: [id], onDelete: Cascade)

  @@id([campaignId, areaId])
}

model Message {
  id          String    @id @default(cuid())
  campaignId  String
  campaign    Campaign  @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  contactId   String
  contact     Contact   @relation(fields: [contactId], references: [id], onDelete: Cascade)
  phone       String
  body        String    @db.Text
  status      String    @default("PENDING") // PENDING|QUEUED|SENT|DELIVERED|READ|FAILED
  sentAt      DateTime?
  deliveredAt DateTime?
  readAt      DateTime?
  failedAt    DateTime?
  failReason  String?   @db.Text           // populated on FAILED — shown in campaign UI
  reply       Reply?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
}

model Reply {
  id              String   @id @default(cuid())
  messageId       String   @unique
  message         Message  @relation(fields: [messageId], references: [id], onDelete: Cascade)
  phone           String
  body            String   @db.Text
  claudeCategory  String?  // "confirmed" | "denied" | "question" | "unclear" | "other"
  claudeSentiment String?  // "positive" | "neutral" | "negative"
  claudeSummary   String?  @db.Text
  claudeRaw       Json?    // full Claude response for debugging
  jawaban         Int?     // 1 = confirmed (Ya), 0 = denied (Tidak), null = unclear
  screenshotPath  String?  @db.VarChar(500) // relative to OUTPUT_FOLDER
  receivedAt      DateTime @default(now())
}

model DailySendLog {
  id        String   @id @default(cuid())
  date      String   @unique  // "YYYY-MM-DD" in WIB
  count     Int      @default(0)
  updatedAt DateTime @updatedAt
}
```

---

## API Routes

### Browser / WhatsApp Session

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/browser/status` | Browser + WA Web connection status (connected/disconnected/qr/loading) |
| `GET` | `/api/browser/screenshot` | Current browser screenshot as base64 (for UI preview) |
| `POST` | `/api/browser/start` | Send start command to worker via Redis pub/sub |
| `POST` | `/api/browser/stop` | Send stop command to worker via Redis pub/sub |
| `GET` | `/api/browser/events` | SSE stream — browser status, delivery updates, reply notifications |

### Files / Import

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/files/scan` | Scan DATA_FOLDER, return dept/area tree (folder-based) |
| `GET` | `/api/files/areas` | Return imported areas from DB grouped by department (with IDs) |
| `POST` | `/api/files/parse` | Parse a single xlsx, return headers + sample rows |
| `POST` | `/api/analyze/headers` | Send headers+samples to Claude, get column mapping suggestion |
| `POST` | `/api/files/import` | Confirm mapping, normalize phones, save to DB |

### Contacts

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/contacts` | List contacts (filter: dept, area, phoneValid, waChecked) |
| `GET` | `/api/contacts/:id` | Single contact detail |
| `POST` | `/api/contacts/validate-wa` | Queue WA registration checks. Body: `{ areaId?, recheck? }`. Default: only unchecked contacts. `recheck: true` re-checks all. |
| `GET` | `/api/contacts/validate-wa/status` | Live phone-check queue counts: `{ waiting, active, completed, failed, total }` |

### Campaigns

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/campaigns` | List all campaigns |
| `POST` | `/api/campaigns` | Create new campaign |
| `GET` | `/api/campaigns/:id` | Get campaign detail + stats |
| `PATCH` | `/api/campaigns/:id` | Update campaign (draft only) |
| `DELETE` | `/api/campaigns/:id` | Delete campaign (draft only) |
| `POST` | `/api/campaigns/:id/enqueue` | Enqueue contacts (`phoneValid=true AND waChecked=true` only) |
| `POST` | `/api/campaigns/:id/pause` | Pause campaign |
| `POST` | `/api/campaigns/:id/resume` | Resume paused campaign |
| `POST` | `/api/campaigns/:id/cancel` | Cancel campaign |
| `GET` | `/api/campaigns/:id/events` | SSE stream — live progress for this campaign |
| `GET` | `/api/campaigns/:id/messages` | Paginated message list with statuses |

### Reply Analysis

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/analyze/reply` | Analyze a reply with Claude + trigger CSV report generation |
| `POST` | `/api/analyze/vary` | Generate Claude-varied version of a rendered message |

### Export

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/export/responses` | Download all responses as xlsx (filter: date, dept, area) |
| `POST` | `/api/export/write` | Write response xlsx files to OUTPUT_FOLDER |
| `POST` | `/api/export/report` | Regenerate CSV report(s). Body: `{ areaId? }` — omit to regenerate all |

---

## Browser Automation (Playwright)

### Architecture

The Playwright browser runs as a **long-lived singleton** managed by `packages/worker/src/lib/browser.ts` inside the worker process. It is launched once when the worker starts and kept alive for the session.

```
packages/worker/src/lib/browser.ts
  └── BrowserManager (singleton)
        ├── launch()                — starts Chromium with persistent profile + stealth
        ├── getPage()               — returns active WhatsApp Web page
        ├── sendMessage()           — full human-simulation send flow (browser-locked)
        ├── checkPhoneRegistered()  — Promise.race compose/popup detection (browser-locked)
        ├── pollReplies()           — DOM scan for unread chats
        ├── getStatus()             — connected | qr | loading | disconnected
        ├── screenshot()            — base64 screenshot for UI preview
        └── _withBrowserLock()      — mutex serialising all page interactions
```

The API reads browser status by querying Redis (updated by the worker on every status change). Browser control commands (start/stop) travel from API → Redis pub/sub → worker.

### Browser Launch Config

```ts
this.context = await chromium.launchPersistentContext(PROFILE_PATH, {
  headless: false,                    // visible window — required
  args: [
    '--no-sandbox',
    '--start-maximized',
    '--disable-blink-features=AutomationControlled',
  ],
  viewport: null,                     // use real window size
  userAgent: '<real Chrome UA>',      // match actual Chrome version
  locale: 'id-ID',
  timezoneId: 'Asia/Jakarta',
})

// Stealth: applied via addInitScript (not playwright-extra which breaks launchPersistentContext)
await this.context.addInitScript(STEALTH_SCRIPT)
```

### Human-Simulation Send Flow (per message)

```
1. Navigate to https://web.whatsapp.com/send?phone={number}&text= (domcontentloaded)
2. Wait for "Starting Chat..." overlay to disappear (max 10s)
3. Check for "Nomor tidak terdaftar" popup (5s):
   — if found: click OK button to dismiss, throw error → job fails → contact marked invalid
4. Wait for compose box (max 30s)
5. Click compose box
6. Type message character by character (80–180ms per key, Shift+Enter for newlines)
7. Random pause 1–3s before sending
8. Click Send button (never programmatic Enter)
9. Wait 1.5s after send
```

### WA Registration Check Flow (`checkPhoneRegistered`)

```
1. Navigate to https://web.whatsapp.com/send?phone={number}&text= (domcontentloaded)
2. Race with 20s timeout:
   a. Compose box appears  → return true  (registered)
   b. Popup appears        → dismiss popup, return false (not registered)
   c. Both timeout         → return true  (safe fallback — don't wrongly invalidate)
```

### Delivery Status Detection

| DOM indicator | Status update |
|---|---|
| Single grey tick (`[data-icon="msg-time"]`) | SENT |
| Double grey tick (`[data-icon="msg-dblcheck"]`) | DELIVERED |
| Double blue tick (`[data-icon="msg-dblcheck-blue"]`) | READ |

Polling every 10s for 3 minutes after each send.

### Reply Detection (DOM Polling)

A background loop runs every `REPLY_POLL_INTERVAL_MS` (60s):

```
1. Scan chat list for items with unread badge
2. For each unread chat:
   a. Click the chat, extract phone number from the header
   b. FILTER — skip if phone is NOT in our sent-messages list
      (prevents processing random incoming messages on your personal WhatsApp)
   c. Read last incoming message text from DOM
   d. Take a screenshot of the chat → save to OUTPUT_FOLDER/screenshots/{phone}_{timestamp}.jpg
   e. Create Reply record in DB (with screenshotPath)
   f. POST /api/analyze/reply → Claude analyzes → CSV report regenerated
3. Only phones we have a SENT/DELIVERED/READ message to are processed
```

---

## Reply Analysis & CSV Report

### Flow

```
Worker detects reply
  → creates Reply record in DB
  → POST /api/analyze/reply
      → Claude categorizes (confirmed/denied/question/unclear/other)
      → determineJawaban() resolves binary 1 or 0
      → generateAreaReport(areaId) regenerates CSV (fire-and-forget)
```

### Jawaban determination

`jawaban` is determined entirely by Claude (Job 2). No keyword matching. Claude returns `jawaban` directly in its JSON response alongside `category`, `sentiment`, and `summary`.

| Claude `jawaban` | Meaning |
|---|---|
| `1` | Store confirmed they did the exchange (Ya/confirmed) |
| `0` | Store denied the exchange (Tidak/denied) |
| `null` | Unclear, question, or off-topic — excluded from CSV report |

Claude handles all informal Indonesian variations: "iya", "betul", "sudah", "ada" → 1; "tidak", "belum", "ngga", "gak", "blm", "ndak" → 0.

### CSV Output Format

Written to `OUTPUT_FOLDER/{Department Name}/{Area Name}_{YYYY-MM-DD}.csv` — date suffix shows when the file was last generated. Same date = overwritten. New date = new file alongside previous ones.

```csv
Nama Toko,Nomor HP Toko,Jawaban,Screenshot
Toko ABC,+628121234567,1,/path/to/output/screenshots/628121234567_2026-03-14T08-30-00.jpg
Toko XYZ,+628121234568,0,/path/to/output/screenshots/628121234568_2026-03-14T09-15-00.jpg
```

- Only contacts with a clear `1` or `0` are included
- `Screenshot` column contains the absolute path to the `.jpg` file — open in any image viewer
- Screenshots saved to `OUTPUT_FOLDER/screenshots/{phone}_{timestamp}.jpg`
- File is fully rewritten on each reply (idempotent)
- Triggered automatically on every analyzed reply
- Can be manually triggered via `POST /api/export/report`

---

## Queue Architecture (BullMQ)

### Queue 1: `whatsapp-messages`

**Job Payload (`MessageJob`):**
```ts
interface MessageJob {
  messageId: string
  campaignId: string
  contactId: string
  phone: string   // +62...
  body: string    // rendered message (pre-variation)
}
```

**Worker logic (per job):**
1. Verify message still exists in DB (skip stale jobs)
2. Wait for browser to be connected (poll every 10s, max 10 min)
3. Check `DailySendLog` — if today's count >= `DAILY_SEND_CAP`: sleep until tomorrow 08:00
4. Check current time in `Asia/Jakarta` — if outside working hours: sleep until next open
5. Check mid-session break counter — if N messages since last break: sleep random 3–8 min
6. Call Claude to generate varied message body (Job 3)
7. `await sleep(gaussianDelay())` — human-like interval
8. Call `browserManager.sendMessage(phone, variedBody)` — browser-locked
9. Update `Message.status = SENT`, `sentAt = now()`
10. Increment `DailySendLog.count`
11. Increment `Campaign.sentCount`

**On failure:**
- Mark `Message.status = FAILED`, store `failReason`
- If `failReason` contains `"tidak terdaftar"`: also set `contact.phoneValid = false, waChecked = true`

**Retry:** 3 attempts with exponential backoff (5s base).

---

### Queue 2: `phone-check`

**Job Payload (`PhoneCheckJob`):**
```ts
interface PhoneCheckJob {
  phone: string       // +62...
  contactId?: string  // if provided, worker updates contact.phoneValid + waChecked
}
```

**Worker logic (per job):**
1. Wait for browser to be connected (poll every 5s, max 5 min)
2. Call `browserManager.checkPhoneRegistered(phone)` — browser-locked
3. If `contactId` provided: update `contact.phoneValid = registered, waChecked = true`
4. Log result

**No retries** (attempts: 1) — a failed check is simply not recorded; the contact stays `waChecked: false` and can be re-queued.

**Queued by:** `POST /api/contacts/validate-wa`

---

## Anti-Ban Strategy

### Browser Layer

| Measure | Implementation |
|---|---|
| Non-headless browser | `headless: false` — real visible Chromium window |
| Stealth fingerprint removal | Custom `addInitScript` patches (webdriver, chrome runtime, plugins, languages, permissions) |
| Persistent browser profile | `launchPersistentContext` — same cookies/localStorage across sessions |
| Real viewport + screen | `viewport: null` matches physical screen size |
| Real locale + timezone | `locale: 'id-ID'`, `timezoneId: 'Asia/Jakarta'` |

### Interaction Layer

| Measure | Implementation |
|---|---|
| Human typing speed | 80–180ms per keystroke with random jitter |
| Pre/post-action pauses | Random pauses between each UI action |
| Click vs Enter | Always click the Send button — never programmatic Enter key |

### Timing Layer

| Measure | Implementation |
|---|---|
| Gaussian interval | Mean 35s, stddev 8s, floor 20s, ceiling 90s — never mechanical |
| Working hours only | 08:00–17:00 WIB, Mon–Sat |
| Daily hard cap | `DAILY_SEND_CAP=150` — stops queue when reached |
| Mid-session breaks | Every 30 messages → random 3–8 min pause |

### Content Layer

| Measure | Implementation |
|---|---|
| Message variation | Claude subtly rephrases each message before send (Job 3) |
| No identical content | No two outgoing messages have the same byte content |

### Session Layer

| Measure | Implementation |
|---|---|
| Never log out | Browser profile persisted indefinitely |
| Single session only | One Playwright instance — no parallel sends |
| Consistent "device" | Same browser profile = same fingerprint every session |

---

## Gaussian Rate Limiter

```ts
// packages/worker/src/lib/scheduler.ts

function gaussianDelay(): number {
  // Box-Muller transform
  const u1 = Math.random()
  const u2 = Math.random()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  const ms = RATE_LIMIT_MEAN_MS + z * RATE_LIMIT_STDDEV_MS
  return Math.min(Math.max(ms, RATE_LIMIT_MIN_MS), RATE_LIMIT_MAX_MS)
}
```

---

## Claude AI Integration

### Job 1 — Header Mapping (at import time)

```
You are a data mapping assistant. Given these Excel column headers and sample rows
from an Indonesian/Chinese bilingual spreadsheet, identify which column corresponds
to each field.

Headers: [...]
Sample rows: [...]

Return JSON only:
{
  "phone": "<exact header string>",
  "store_name": "<exact header string>",
  "seq_no": "<exact header string or null>",
  "freezer_id": "<exact header string or null>",
  "exchange_count": "<exact header string or null>",
  "award_count": "<exact header string or null>",
  "total_count": "<exact header string or null>"
}
```

### Job 2 — Reply Analysis (on each incoming reply)

Returns `jawaban` (1/0/null) directly — no separate keyword matching step.

```
You are analyzing a WhatsApp reply from an Indonesian small business owner.
They were asked: "Apakah benar bahwa pada bulan {{bulan}} toko bapak/ibu telah
melakukan penukaran Stick ke distributor?"

Reply: "{{reply_text}}"

Return JSON only:
{
  "category": "confirmed" | "denied" | "question" | "unclear" | "other",
  "sentiment": "positive" | "neutral" | "negative",
  "summary": "<one sentence in Indonesian summarising the reply>",
  "jawaban": 1 | 0 | null
}

jawaban rules:
- 1    = store confirmed they did the exchange (category is "confirmed")
- 0    = store denied they did the exchange (category is "denied")
- null = cannot determine a clear yes or no (question/unclear/other)
```

### Job 3 — Message Variation (before each send)

```
You are a WhatsApp message variation assistant. Rewrite the message below with
minor surface-level changes so it does not look identical to other messages in
the same batch. Rules:
- Keep all {{variables}} and their values exactly as-is
- Keep the meaning, tone, and language (Indonesian) identical
- Only change: punctuation, minor word order, synonym swaps, spacing
- The result must still sound natural and professional
- Return only the rewritten message, no explanation

Message: "{{rendered_message}}"
```

---

## Working Hours Scheduler

```ts
// packages/worker/src/lib/scheduler.ts

const TIMEZONE = 'Asia/Jakarta'
const START_HOUR = 8   // 08:00
const END_HOUR = 17    // 17:00
const WORKING_DAYS = [1, 2, 3, 4, 5, 6]  // Mon–Sat

function isWorkingHours(): boolean
function msUntilNextOpen(): number     // ms to sleep if outside working hours
function gaussianDelay(): number       // Gaussian-jittered interval between sends
function randomBreakDuration(): number // random 3–8 min mid-session break
```

---

## UI Pages

### `/` — Dashboard
- Cards: Total contacts, active campaigns, messages sent today, reply rate today, daily cap remaining
- Recent campaigns table (name, status, progress bar, reply rate)
- Browser status badge (connected / needs QR / disconnected)
- Live browser screenshot preview (refreshes every 5s)

### `/import` — Import Contacts
- Folder tree of Department 1–9 → Areas
- Per-area: import button → shows parsed headers
- Claude suggests column mapping → user reviews + confirms
- Import progress: valid contacts / invalid phones / skipped duplicates

### `/contacts` — Contact Browser
- Filter by status: **Semua / Belum dicek / Terdaftar / Tidak valid**
- **"Validasi WA"** button — queues unchecked contacts for WA registration check
- **"Cek Ulang Semua"** button — re-queues all contacts regardless of current status
- Columns: No, Store Name, Department, Area, Phone (raw), Phone (normalized), **Status WA**, Exchange
- Status WA badge: Gray "Belum dicek" / Green "Terdaftar" / Red "Tidak valid"

### Global — WA Validation Banner
- Appears at the **top of every page** while phone-check jobs are in flight
- Shows spinner + counts: `{active} sedang dicek, {waiting} antrian tersisa`
- Polls `GET /api/contacts/validate-wa/status` every 4 seconds
- Disappears automatically when queue is empty

### `/campaigns` — Campaign List
- Status badges: DRAFT / RUNNING / PAUSED / COMPLETED / CANCELLED
- Progress bar: `sent/total`
- Actions: View, Cancel

### `/campaigns/new` — Create Campaign
1. Name + `{{bulan}}` field
2. Message template editor
3. Select target areas — **Department → Area tree** (collapsible, per-area checkboxes with dept-level select-all)
4. Selected area count shown live
5. Submit → status = DRAFT; "Start Campaign" button on detail page

Campaign targets specific **areas** (not whole departments). At enqueue time, only contacts with `phoneValid = true AND waChecked = true` are queued.

### `/campaigns/:id` — Campaign Detail
- Progress: sent / delivered / read / failed
- Live SSE feed updating counts in real-time
- Pause / Resume / Cancel buttons
- Message table (paginated, filterable by status)
- **FAILED messages** show a clickable "FAILED ℹ" badge — clicking opens a modal (`FailReasonModal`) with the full `failReason` (e.g. "Nomor +628xx tidak terdaftar di WhatsApp")
- Reply summary (confirmed % / denied % / unclear %)

### `/responses` — Reply Inbox
- Table: Store Name | Area | Dept | Message Sent | Reply | Category | Sentiment | Time
- Export to XLSX button (`GET /api/export/responses`)
- "Write to Output Folder" button (`POST /api/export/write`)
- "Regenerate CSV Reports" button (`POST /api/export/report`)

### `/settings` — Settings
- Browser: live screenshot, status badge, Open / Close / Refresh buttons
- QR code prompt when WA Web needs re-authentication
- Config display (working hours, rate limits, daily cap) — read-only from env

---

## Output Files

### XLSX — full response log

Written to `OUTPUT_FOLDER/responses_YYYY-MM-DD.xlsx`:

| Nama Toko | No HP | Pesan Dikirim | Status | Waktu Kirim | Balasan | Kategori | Sentimen | Ringkasan | Waktu Balas |
|---|---|---|---|---|---|---|---|---|---|

### CSV — binary confirmation report (auto-generated per reply)

Written to `OUTPUT_FOLDER/{Department Name}/{Area Name}.csv`:

```csv
Nama Toko,Nomor HP Toko,Jawaban,Screenshot
Toko ABC,+628121234567,1,/path/to/output/screenshots/628121234567_2026-03-14.jpg
Toko XYZ,+628121234568,0,
```

`Jawaban` is set by Claude (Job 2) — `1` = confirmed, `0` = denied, absent = unclear (excluded from CSV).
Filename includes `YYYY-MM-DD` so you can track when data was last updated.

---

## Useful Scripts

```bash
pnpm dev              # start all packages in parallel (api + worker + web)
pnpm dev:api          # API server only
pnpm dev:worker       # worker only
pnpm dev:web          # web only

pnpm db:migrate       # run Prisma migrations
pnpm db:generate      # regenerate Prisma client
pnpm db:studio        # open Prisma Studio
pnpm db:fresh         # drop + recreate DB (destructive)

pnpm redis:flush      # FLUSHALL — clear all Redis keys + BullMQ queues
```

---

## Project File Structure

```
whatsapp-automation/
├── packages/
│   ├── shared/
│   │   └── src/index.ts              # All shared TypeScript types
│   ├── api/
│   │   ├── prisma/schema.prisma      # MySQL schema (single source of truth)
│   │   └── src/
│   │       ├── index.ts              # Express app + startup validation
│   │       ├── lib/
│   │       │   ├── db.ts             # Prisma client
│   │       │   ├── excel.ts          # SheetJS folder scanner + xlsx parser
│   │       │   ├── phone.ts          # Indonesian phone normalizer + validator
│   │       │   ├── claude.ts         # Anthropic SDK (Job 1: headers, Job 2: reply)
│   │       │   ├── queue.ts          # bullmq queue producers (messages + phone-check) + Redis
│   │       │   ├── exporter.ts       # Output xlsx writer
│   │       │   ├── report.ts         # Per-area CSV report generator (Jawaban 1/0)
│   │       │   └── validate.ts       # Startup env + connection checks
│   │       └── routes/
│   │           ├── browser.ts        # /api/browser/*
│   │           ├── files.ts          # /api/files/*
│   │           ├── contacts.ts       # /api/contacts/* (incl. validate-wa)
│   │           ├── campaigns.ts      # /api/campaigns/*
│   │           ├── analyze.ts        # /api/analyze/*
│   │           └── export.ts         # /api/export/*
│   ├── worker/
│   │   └── src/
│   │       ├── index.ts              # BullMQ workers (messages + phone-check) + startup
│   │       └── lib/
│   │           ├── browser.ts        # BrowserManager singleton (Playwright + browser lock)
│   │           ├── claude.ts         # Anthropic SDK (Job 3: message variation)
│   │           ├── db.ts             # Prisma client
│   │           ├── redis.ts          # Redis connection
│   │           ├── scheduler.ts      # Working hours, Gaussian delay, break logic
│   │           └── validate.ts       # Startup env + connection checks
│   └── web/
│       └── src/
│           ├── main.tsx
│           ├── App.tsx               # React Router routes
│           ├── lib/utils.ts          # cn(), apiFetch()
│           ├── components/layout/
│           │   ├── Layout.tsx        # App shell — sidebar + WaValidationBanner + outlet
│           │   ├── Sidebar.tsx
│           │   └── WaValidationBanner.tsx  # Global banner while phone-check queue is active
│           └── pages/                # Dashboard, Import, Contacts, Campaigns,
│                                     # NewCampaign, CampaignDetail, Responses, Settings
├── .env
├── .env.example
├── package.json                      # pnpm workspace root + scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── spec/SPEC.md
```

---

## Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| WhatsApp account ban | Visible browser, stealth init script, Gaussian timing, daily cap, working hours, message variation, mid-session breaks |
| WhatsApp Web UI changes | Playwright selectors abstracted in `browser.ts` for easy updates |
| Browser crashes | BrowserManager restarts on crash; bullmq jobs are durable (Redis-backed) |
| Inconsistent Excel headers | Claude-assisted mapping with user confirmation step |
| Excel strips leading zero from phone | Normalizer detects `8xxx` prefix and prepends `62` |
| Excel scientific notation for phone | Normalizer detects and parses `8.12E+10` before stripping |
| Messages sent to unregistered numbers | `checkPhoneRegistered` validates before campaign; send failure also auto-invalidates contact |
| Phone check misses unregistered numbers | Promise.race on compose box vs popup — reliable for both valid and invalid numbers |
| Send + phone-check browser collision | `_withBrowserLock` mutex serialises all page interactions |
| Messages sent outside hours | Worker working-hours check sleeps until next 08:00 WIB |
| Daily cap exceeded | `DailySendLog` checked before every job |
| Invalid phone numbers | Format-validated at import; WA-validated before campaign enqueue |
| Redis unavailable | Startup validation exits with error before accepting traffic |
| MySQL unavailable | Startup validation exits with error before accepting traffic |
| Missing env vars | Startup validation exits with clear per-variable error list |
| Session expired (QR needed) | Browser screenshot in Settings shows QR; user scans to re-auth |
| Stale BullMQ jobs after DB reset | `pnpm redis:flush` clears all queues |

---

## Notes

- The Playwright browser runs as a **visible Chromium window** inside `@aice/worker`. It must not be minimized while campaigns are active.
- All timestamps are stored as UTC in MySQL. Timezone conversion to `Asia/Jakarta` happens in the scheduler and UI display layer.
- In production, manage the three processes with `pm2`: API server, worker, and optionally a static web build served by nginx.
- This project uses the WhatsApp Web interface via browser automation. It is against WhatsApp's Terms of Service. Use responsibly. For large-scale or commercial deployments, migrate to the official Meta WhatsApp Business API.
