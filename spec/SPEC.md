# AICE WhatsApp Automation — Project Specification

## Overview

A full-stack web application for managing bulk WhatsApp messaging campaigns targeting AICE ice cream distribution partners. Reads contact data from `.xlsx` files organized by department and market area, sends personalized WhatsApp messages via a real visible Chromium browser controlled by Playwright (mimicking genuine human interaction to minimize ban risk), captures replies via DOM polling, analyzes them with Claude AI, writes results back to output Excel files, and auto-generates per-area CSV reports with binary confirmation answers (1 = confirmed, 0 = denied).

---

## Tech Stack

| Layer | Library/Tool | Version | Notes |
|---|---|---|---|
| Monorepo | pnpm workspaces | latest | 4 packages: shared, api, worker, web |
| API server | Express.js + TypeScript | latest | REST + SSE |
| Frontend | React + Vite + Tailwind CSS + shadcn/ui | latest | Port 5173 |
| Browser Automation | playwright + playwright-extra | latest | Controls real visible Chromium window |
| Anti-Detection | puppeteer-extra-plugin-stealth | latest | Removes headless/automation fingerprints |
| Human Mouse | ghost-cursor | latest | Bezier-curve realistic mouse trajectories |
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
| `@aice/shared` | Shared TypeScript interfaces (MessageJob, CampaignStatus, SSE event types, etc.) |
| `@aice/api` | Express routes, lib utilities (excel, phone, claude, queue producer, exporter, report), Prisma schema |
| `@aice/worker` | BullMQ consumer, BrowserManager singleton, scheduler, Claude variation |
| `@aice/web` | React SPA — all UI pages, Vite proxy to API |

> **BrowserManager ownership**: The Playwright browser runs inside `@aice/worker`. The API reads browser status from the DB/Redis. Browser control commands (start/stop) are sent via Redis pub/sub from API → worker.

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
7. Invalid numbers stored with `phoneValid = false`, flagged in import UI, excluded from queue

---

## Message Template

Static per-campaign template with variable substitution. Variables use `{{variable_name}}` syntax.

### Default Template

```
Halo bapak/ibu mitra aice toko {{nama_toko}}, saya dari tim inspeksi aice pusat di Jakarta ingin konfirmasi. Apakah benar pada bulan {{bulan}} toko bapak/ibu ada melakukan penukaran Stick ke distributor?
Terimakasih atas konfirmasinya,
Have an aice day!
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
  id        String               @id @default(cuid())
  name      String               @unique
  path      String               @db.VarChar(500)
  areas     Area[]
  contacts  Contact[]
  campaigns CampaignDepartment[]
  createdAt DateTime             @default(now())
  updatedAt DateTime             @updatedAt
}

model Area {
  id            String     @id @default(cuid())
  name          String
  fileName      String
  filePath      String     @db.VarChar(500)
  columnMapping Json?                        // Claude-mapped column keys
  departmentId  String
  department    Department @relation(fields: [departmentId], references: [id], onDelete: Cascade)
  contacts      Contact[]
  createdAt     DateTime   @default(now())
  updatedAt     DateTime   @updatedAt

  @@unique([departmentId, name])
}

model Contact {
  id            String     @id @default(cuid())
  seqNo         String?
  storeName     String
  freezerId     String?
  phoneRaw      String
  phoneNorm     String
  phoneValid    Boolean    @default(true)
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
  id             String               @id @default(cuid())
  name           String
  template       String               @db.Text
  bulan          String
  status         String               @default("DRAFT") // DRAFT|RUNNING|PAUSED|COMPLETED|CANCELLED
  departments    CampaignDepartment[]
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

model CampaignDepartment {
  campaignId   String
  departmentId String
  campaign     Campaign   @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  department   Department @relation(fields: [departmentId], references: [id], onDelete: Cascade)

  @@id([campaignId, departmentId])
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
  failReason  String?   @db.Text
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
| `GET` | `/api/files/scan` | Scan DATA_FOLDER, return dept/area tree |
| `POST` | `/api/files/parse` | Parse a single xlsx, return headers + sample rows |
| `POST` | `/api/analyze/headers` | Send headers+samples to Claude, get column mapping suggestion |
| `POST` | `/api/files/import` | Confirm mapping, normalize phones, save to DB |

### Contacts

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/contacts` | List contacts (filter: dept, area, phoneValid) |
| `GET` | `/api/contacts/:id` | Single contact detail |

### Campaigns

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/campaigns` | List all campaigns |
| `POST` | `/api/campaigns` | Create new campaign |
| `GET` | `/api/campaigns/:id` | Get campaign detail + stats |
| `PATCH` | `/api/campaigns/:id` | Update campaign (draft only) |
| `DELETE` | `/api/campaigns/:id` | Delete campaign (draft only) |
| `POST` | `/api/campaigns/:id/enqueue` | Enqueue all contacts into bullmq |
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
        ├── launch()         — starts Chromium with persistent profile + stealth
        ├── getPage()        — returns active WhatsApp Web page
        ├── sendMessage()    — full human-simulation send flow
        ├── pollReplies()    — DOM scan for unread chats
        ├── getStatus()      — connected | qr | loading | disconnected
        └── screenshot()     — base64 screenshot for UI preview
```

The API reads browser status by querying the DB or Redis (updated by the worker). Browser control commands (start/stop) travel from API → Redis pub/sub → worker.

### Browser Launch Config

```ts
chromiumExtra.use(StealthPlugin())

const browser = await chromiumExtra.launch({
  headless: false,                    // visible window — required
  args: [
    '--no-sandbox',
    '--start-maximized',
    '--disable-blink-features=AutomationControlled',
  ],
})

const context = await browser.newContext({
  userDataDir: BROWSER_PROFILE_PATH,  // persistent session — QR scan only once
  viewport: null,                     // use real window size
  userAgent: '<real Chrome UA>',      // match actual Chrome version
  locale: 'id-ID',
  timezoneId: 'Asia/Jakarta',
})
```

### Human-Simulation Send Flow (per message)

```
1. Move cursor to search bar using ghost-cursor (Bezier path from current position)
2. Click search bar
3. Random pause: 800–1500ms
4. Type phone number character by character (80–180ms per keystroke, ±30ms jitter)
5. Wait for contact suggestion to appear (up to 5s)
6. Move cursor to first suggestion result
7. Click the contact
8. Random pause: 1200–3000ms  (simulating "reading" the chat history)
9. Occasionally scroll up in chat: 30% probability
10. Move cursor to message input box
11. Click message input
12. Random pause: 500–1200ms
13. Type message character by character (60–160ms per keystroke)
    — newlines: pause 300–600ms before continuing
14. Random pause before sending: 1000–3000ms
15. Move cursor to Send button (ghost-cursor path)
16. Click Send button  (not Enter key — more human-like)
17. Wait 800–1500ms after send
18. Mark message as SENT in DB
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
1. Scan chat list for items with unread badge (blue circle with count)
2. For each unread chat:
   a. Extract phone number from chat metadata
   b. Match to Contact in DB
   c. If matched: click chat, read latest incoming message text from DOM
   d. Create Reply record in DB
   e. Call POST /api/analyze/reply → Claude analyzes → CSV report generated
   f. Emit SSE event to UI
3. An immediate poll is also triggered after each outgoing message send
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

Binary answer is determined by two-pass logic:

**Pass 1 — keyword matching on raw reply text (priority)**

Negative keywords checked before positive to avoid false positives (e.g. "ya, tidak ada" → 0):

| Jawaban | Keywords |
|---|---|
| `0` | tidak tau, tidak tahu, nggak tau, belum ada, tidak ada, nggak ada, tidak dapat, nggak dapat, tidak pernah, tidak, nggak, ngga, ndak, gak, no |
| `1` | sudah ada, pernah ada, ada penukaran, benar ada, iya ada, ya ada, sudah, benar, betul, pernah, iya, yes, ya |

**Pass 2 — Claude category fallback**

| claudeCategory | Jawaban |
|---|---|
| `confirmed` | `1` |
| `denied` | `0` |
| `question` / `unclear` / `other` | excluded from report |

### CSV Output Format

Written to `OUTPUT_FOLDER/{Department Name}/{Area Name}.csv`:

```csv
Nama Toko,Nomor HP Toko,Jawaban
Toko ABC,+628121234567,1
Toko XYZ,+628121234568,0
```

- Only contacts with a clear `1` or `0` are included
- File is fully rewritten on each reply (idempotent)
- Triggered automatically on every analyzed reply
- Can be manually triggered via `POST /api/export/report`

---

## Anti-Ban Strategy

### Browser Layer

| Measure | Implementation |
|---|---|
| Non-headless browser | `headless: false` — real visible Chromium window |
| Stealth fingerprint removal | `playwright-extra` + `puppeteer-extra-plugin-stealth` |
| Persistent browser profile | `userDataDir` — same cookies/localStorage across sessions |
| Real viewport + screen | `viewport: null` matches physical screen size |
| Real locale + timezone | `locale: 'id-ID'`, `timezoneId: 'Asia/Jakarta'` |

### Interaction Layer

| Measure | Implementation |
|---|---|
| Human mouse paths | `ghost-cursor` — Bezier curve trajectories |
| Human typing speed | 60–180ms per keystroke with ±30ms jitter |
| Pre/post-action pauses | Random 800ms–3s pauses between each UI action |
| Chat history scroll | 30% chance to scroll up in chat before typing |
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

## Queue Architecture (bullmq)

### Queue: `whatsapp-messages`

**Job Payload:**
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
1. Check `DailySendLog` — if today's count >= `DAILY_SEND_CAP`: sleep until tomorrow 08:00
2. Check current time in `Asia/Jakarta` — if outside working hours: sleep until next open
3. Check mid-session break counter — if N messages since last break: sleep random 3–8 min
4. Call Claude to generate varied message body (Job 3)
5. `await sleep(gaussianDelay())` — human-like interval
6. Call `browserManager.sendMessage(phone, variedBody)`
7. Update `Message.status = SENT`, `sentAt = now()`
8. Increment `DailySendLog.count`
9. Emit SSE event to connected campaign listeners
10. Start delivery status polling (background, 10s intervals, 3 min max)

**Processes (managed by pm2 in production):**
```
pnpm --filter @aice/api start      # Express API server
pnpm --filter @aice/worker start   # BullMQ worker + Playwright browser
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

```
You are analyzing a WhatsApp reply from an Indonesian small business owner
in response to a confirmation request about ice cream stick exchange
(penukaran stick es krim).

Context: The sender asked if the store performed a stick exchange in month {{bulan}}.

Reply: "{{reply_text}}"

Return JSON only:
{
  "category": "confirmed" | "denied" | "question" | "unclear" | "other",
  "sentiment": "positive" | "neutral" | "negative",
  "summary": "<one sentence in Indonesian>"
}
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
- Filter by Department, Area, phone validity
- Columns: Store Name, Freezer ID, Phone (raw + normalized), Valid, Exchange Count

### `/campaigns` — Campaign List
- Status badges: DRAFT / RUNNING / PAUSED / COMPLETED / CANCELLED
- Progress bar: `sent/total`
- Actions: View, Cancel

### `/campaigns/new` — Create Campaign
1. Name + `{{bulan}}` field
2. Select target departments (checkbox tree)
3. Message template editor
4. Submit → status = DRAFT; "Start Campaign" button on detail page

### `/campaigns/:id` — Campaign Detail
- Progress: sent / delivered / read / failed
- Live SSE feed updating counts in real-time
- Pause / Resume / Cancel buttons
- Message table (paginated, filterable by status)
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
Nama Toko,Nomor HP Toko,Jawaban
Toko ABC,+628121234567,1
Toko XYZ,+628121234568,0
```

`Jawaban`: `1` = confirmed (Ya/Yes), `0` = denied (Tidak/Nggak). Contacts with unclear replies are excluded.

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
│   │       │   ├── queue.ts          # bullmq queue producer + Redis connection
│   │       │   ├── exporter.ts       # Output xlsx writer
│   │       │   ├── report.ts         # Per-area CSV report generator (Jawaban 1/0)
│   │       │   └── validate.ts       # Startup env + connection checks
│   │       └── routes/
│   │           ├── browser.ts        # /api/browser/*
│   │           ├── files.ts          # /api/files/*
│   │           ├── contacts.ts       # /api/contacts/*
│   │           ├── campaigns.ts      # /api/campaigns/*
│   │           ├── analyze.ts        # /api/analyze/*
│   │           └── export.ts         # /api/export/*
│   ├── worker/
│   │   └── src/
│   │       ├── index.ts              # BullMQ worker + startup validation
│   │       └── lib/
│   │           ├── browser.ts        # BrowserManager singleton (Playwright)
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
│           ├── components/layout/    # Sidebar, Layout
│           └── pages/                # Dashboard, Import, Contacts, Campaigns,
│                                     # NewCampaign, CampaignDetail, Responses, Settings
├── .env
├── .env.example
├── package.json                      # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── spec/SPEC.md
```

---

## Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| WhatsApp account ban | Visible browser, stealth plugin, Gaussian timing, daily cap, working hours, message variation, mid-session breaks |
| WhatsApp Web UI changes | Playwright selectors abstracted in `browser.ts` for easy updates |
| Browser crashes | BrowserManager restarts on crash; bullmq jobs are durable (Redis-backed) |
| Inconsistent Excel headers | Claude-assisted mapping with user confirmation step |
| Excel strips leading zero from phone | Normalizer detects `8xxx` prefix and prepends `62` |
| Excel scientific notation for phone | Normalizer detects and parses `8.12E+10` before stripping |
| Messages sent outside hours | Worker working-hours check sleeps until next 08:00 WIB |
| Daily cap exceeded | `DailySendLog` checked before every job |
| Invalid phone numbers | Validation at import time; invalid phones excluded from queue |
| Redis unavailable | Startup validation exits with error before accepting traffic |
| MySQL unavailable | Startup validation exits with error before accepting traffic |
| Missing env vars | Startup validation exits with clear per-variable error list |
| Session expired (QR needed) | Browser screenshot in Settings shows QR; user scans to re-auth |

---

## Notes

- The Playwright browser runs as a **visible Chromium window** inside `@aice/worker`. It must not be minimized while campaigns are active.
- All timestamps are stored as UTC in MySQL. Timezone conversion to `Asia/Jakarta` happens in the scheduler and UI display layer.
- In production, manage the three processes with `pm2`: API server, worker, and optionally a static web build served by nginx.
- This project uses the WhatsApp Web interface via browser automation. It is against WhatsApp's Terms of Service. Use responsibly. For large-scale or commercial deployments, migrate to the official Meta WhatsApp Business API.
