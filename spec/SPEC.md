# AICE WhatsApp Automation — Project Specification

## Overview

A full-stack web application for managing bulk WhatsApp messaging campaigns targeting AICE ice cream distribution partners. Reads contact data from `.xlsx` files organized by department and market area, sends personalized WhatsApp messages via a real visible Chromium browser controlled by Playwright (mimicking genuine human interaction to minimize ban risk), captures replies via DOM polling, analyzes them with Claude AI, and writes results back to output Excel files.

---

## Tech Stack

| Layer | Library/Tool | Version | Notes |
|---|---|---|---|
| Framework | Next.js 14 (App Router) | latest | Fullstack — UI + API routes |
| UI Components | shadcn/ui + Tailwind CSS | latest | |
| Browser Automation | playwright | latest | Controls real visible Chromium window |
| Anti-Detection | playwright-extra + puppeteer-extra-plugin-stealth | latest | Removes headless/automation fingerprints |
| Human Mouse | ghost-cursor-playwright | latest | Bezier-curve realistic mouse trajectories |
| Excel Parsing | xlsx (SheetJS) | latest | Read `.xlsx`, inconsistent headers |
| AI | @anthropic-ai/sdk | latest | Header mapping, reply analysis, message variation |
| Queue | bullmq + ioredis | latest | Durable rate-limited message queue |
| Database | Prisma + SQLite | latest | Local, no external DB needed |
| Realtime | Server-Sent Events (SSE) | — | Next.js native, no socket.io |
| Language | TypeScript | latest | Strict mode |
| Runtime | Node.js 20+ | — | |

---

## Environment Variables (`.env.local`)

```env
ANTHROPIC_API_KEY=sk-ant-...
DATA_FOLDER=/absolute/path/to/data          # root folder containing Department 1..9
OUTPUT_FOLDER=/absolute/path/to/output      # where response xlsx files are written
REDIS_URL=redis://localhost:6379
DATABASE_URL=file:./prisma/dev.db

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
```

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

Indonesian mobile numbers are normalized to E.164 format for WhatsApp:

```
0821167464117   →  +62821167464117
085341740900    →  +6285341740900
62821xxxxxxx    →  +62821xxxxxxx
+62821xxxxxxx   →  unchanged
```

Rules:
- Strip all spaces, dashes, parentheses
- If starts with `0` → replace with `+62`
- If starts with `62` (no `+`) → prepend `+`
- If starts with `+62` → keep as-is
- Validate: after `+62`, remaining digits must be 8–12 digits
- Invalid numbers flagged in import UI, not enqueued

---

## Message Template

Static per-campaign template with variable substitution. Variables use `{{variable_name}}` syntax.

### Default Template

```
Halo bapak/ibu mitra aice {{no}} toko {{nama_toko}}, saya dari tim inspeksi aice pusat di Jakarta ingin konfirmasi. Apakah benar pada bulan {{bulan}} toko bapak/ibu ada melakukan penukaran Stick ke distributor? 
Terimakasih atas konfirmasinya, 
Have an aice day!
```

### Available Variables

| Variable | Source |
|---|---|
| `{{no}}` | `seq_no` from Excel |
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

## Database Schema (Prisma)

```prisma
model Department {
  id        String   @id @default(cuid())
  name      String   @unique          // "Department 1"
  path      String                    // absolute folder path
  areas     Area[]
  contacts  Contact[]
  campaigns CampaignDepartment[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Area {
  id            String     @id @default(cuid())
  name          String                          // "Aceh Barat"
  fileName      String                          // "Aceh Barat.xlsx"
  filePath      String                          // absolute file path
  columnMapping Json?                           // saved Claude-mapped column keys
  departmentId  String
  department    Department @relation(fields: [departmentId], references: [id])
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
  phoneRaw      String                          // original from Excel
  phoneNorm     String                          // normalized +62...
  phoneValid    Boolean    @default(true)
  exchangeCount Int?
  awardCount    Int?
  totalCount    Int?
  areaId        String
  area          Area       @relation(fields: [areaId], references: [id])
  departmentId  String
  department    Department @relation(fields: [departmentId], references: [id])
  messages      Message[]
  createdAt     DateTime   @default(now())
  updatedAt     DateTime   @updatedAt

  @@unique([areaId, phoneNorm])
}

model Campaign {
  id             String               @id @default(cuid())
  name           String
  template       String               // message template with {{variables}}
  bulan          String               // static month, e.g. "12" or "Desember"
  status         CampaignStatus       @default(DRAFT)
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
  campaign     Campaign   @relation(fields: [campaignId], references: [id])
  department   Department @relation(fields: [departmentId], references: [id])

  @@id([campaignId, departmentId])
}

model Message {
  id          String        @id @default(cuid())
  campaignId  String
  campaign    Campaign      @relation(fields: [campaignId], references: [id])
  contactId   String
  contact     Contact       @relation(fields: [contactId], references: [id])
  phone       String                              // normalized phone at send time
  body        String                              // rendered + Claude-varied message
  status      MessageStatus @default(PENDING)
  sentAt      DateTime?
  deliveredAt DateTime?
  readAt      DateTime?
  failedAt    DateTime?
  failReason  String?
  reply       Reply?
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt
}

model Reply {
  id               String   @id @default(cuid())
  messageId        String   @unique
  message          Message  @relation(fields: [messageId], references: [id])
  phone            String
  body             String                          // raw reply text
  claudeCategory   String?  // "confirmed" | "denied" | "question" | "unclear" | "other"
  claudeSentiment  String?  // "positive" | "neutral" | "negative"
  claudeSummary    String?
  claudeRaw        Json?    // full Claude response for debugging
  receivedAt       DateTime @default(now())
}

// Tracks daily send count for DAILY_SEND_CAP enforcement
model DailySendLog {
  id        String   @id @default(cuid())
  date      String   @unique  // "YYYY-MM-DD" in WIB
  count     Int      @default(0)
  updatedAt DateTime @updatedAt
}

enum CampaignStatus {
  DRAFT
  RUNNING
  PAUSED
  COMPLETED
  CANCELLED
}

enum MessageStatus {
  PENDING
  QUEUED
  SENT
  DELIVERED
  READ
  FAILED
}
```

---

## API Routes

### Browser / WhatsApp Session

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/browser/status` | Browser + WA Web connection status (connected/disconnected/qr/loading) |
| `GET` | `/api/browser/screenshot` | Current browser screenshot as base64 (for UI preview) |
| `POST` | `/api/browser/start` | Launch Playwright browser, open web.whatsapp.com |
| `POST` | `/api/browser/stop` | Close browser gracefully |
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
| `GET` | `/api/contacts/[id]` | Single contact detail |

### Campaigns

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/campaigns` | List all campaigns |
| `POST` | `/api/campaigns` | Create new campaign |
| `GET` | `/api/campaigns/[id]` | Get campaign detail + stats |
| `PATCH` | `/api/campaigns/[id]` | Update campaign (draft only) |
| `DELETE` | `/api/campaigns/[id]` | Delete campaign (draft only) |
| `POST` | `/api/campaigns/[id]/enqueue` | Enqueue all contacts into bullmq |
| `POST` | `/api/campaigns/[id]/pause` | Pause campaign (drain queue) |
| `POST` | `/api/campaigns/[id]/resume` | Resume paused campaign |
| `POST` | `/api/campaigns/[id]/cancel` | Cancel campaign |
| `GET` | `/api/campaigns/[id]/events` | SSE stream — live progress for this campaign |
| `GET` | `/api/campaigns/[id]/messages` | Paginated message list with statuses |

### Reply Analysis

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/analyze/reply` | Analyze a reply with Claude (called internally by worker) |
| `POST` | `/api/analyze/vary` | Generate Claude-varied version of a rendered message |

### Export

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/export/responses` | Download all responses as xlsx (filter: date, dept, area) |
| `POST` | `/api/export/write` | Write response files to OUTPUT_FOLDER |

---

## Browser Automation (Playwright)

### Architecture

The Playwright browser runs as a **long-lived singleton** managed by `lib/browser.ts`. It is launched once when the app starts (or manually via the Settings page) and kept alive for the session. It is NOT created per-request.

```
lib/browser.ts
  └── singleton BrowserManager class
        ├── launch()         — starts Chromium with persistent profile + stealth
        ├── getPage()        — returns active WhatsApp Web page
        ├── sendMessage()    — full human-simulation send flow
        ├── pollReplies()    — DOM scan for unread chats
        ├── getStatus()      — connected | qr | loading | disconnected
        └── screenshot()     — base64 screenshot for UI preview
```

### Browser Launch Config

```ts
const browser = await chromium.launch({
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

Stealth plugin applied via `playwright-extra` before launch — removes `navigator.webdriver`, fixes Chrome runtime, plugins array, permissions, etc.

### Human-Simulation Send Flow (per message)

Each send action follows this exact sequence inside `BrowserManager.sendMessage()`:

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
17. Wait 800–1500ms after send (observe message delivered to input)
18. Mark message as SENT in DB
```

### Delivery Status Detection

Playwright polls the DOM of the active chat after send to detect tick marks:

| DOM indicator | Status update |
|---|---|
| Single grey tick (`[data-icon="msg-time"]`) | SENT |
| Double grey tick (`[data-icon="msg-dblcheck"]`) | DELIVERED |
| Double blue tick (`[data-icon="msg-dblcheck-blue"]`) | READ |

Polling happens every 10s for the 3 minutes following each send, then stops (no further updates expected).

### Reply Detection (DOM Polling)

A background loop runs every `REPLY_POLL_INTERVAL_MS` (60s):

```
1. Scan chat list for items with unread badge (blue circle with count)
2. For each unread chat:
   a. Extract phone number from chat metadata
   b. Match to Contact in DB
   c. If matched: click chat, read latest incoming message text from DOM
   d. Create Reply record in DB
   e. Trigger Claude analysis via /api/analyze/reply
   f. Emit SSE event to UI
3. An immediate poll is also triggered after each outgoing message send
   (in case a fast reply arrives)
```

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
| Human mouse paths | `ghost-cursor-playwright` — Bezier curve trajectories |
| Human typing speed | 60–180ms per keystroke with ±30ms jitter |
| Pre/post-action pauses | Random 800ms–3s pauses between each UI action |
| Chat history scroll | 30% chance to scroll up in chat before typing (simulates reading) |
| Click vs Enter | Always click the Send button — never programmatic Enter key |

### Timing Layer

| Measure | Implementation |
|---|---|
| Gaussian interval | Mean 35s, stddev 8s, floor 20s, ceiling 90s — never mechanical |
| Working hours only | 08:00–17:00 WIB, Mon–Sat |
| Daily hard cap | `DAILY_SEND_CAP=150` — stops queue when reached |
| Mid-session breaks | Every 30 messages → random 3–8 min pause (simulates user break) |
| Gradual ramp-up | Configurable: Week 1: 50/day → Week 2: 100/day → Week 3: 150/day |

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

Fixed intervals are detectable. The queue uses Gaussian-distributed delays:

```ts
// lib/scheduler.ts

function gaussianDelay(): number {
  // Box-Muller transform
  const u1 = Math.random()
  const u2 = Math.random()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  const ms = RATE_LIMIT_MEAN_MS + z * RATE_LIMIT_STDDEV_MS
  return Math.min(Math.max(ms, RATE_LIMIT_MIN_MS), RATE_LIMIT_MAX_MS)
}
```

bullmq does not natively support per-job dynamic delay for rate limiting, so the worker itself `await sleep(gaussianDelay())` before processing each job, after the working-hours check passes.

---

## Queue Architecture (bullmq)

### Queue: `whatsapp-messages`

**Job Payload:**
```ts
interface MessageJob {
  messageId: string
  campaignId: string
  contactId: string
  phone: string       // +62...
  body: string        // rendered message (pre-variation)
}
```

**Worker logic (per job):**
1. Check `DailySendLog` — if today's count >= `DAILY_SEND_CAP`: throw `DelayedError` until tomorrow 08:00
2. Check current time in `Asia/Jakarta`
3. If outside working hours: throw `DelayedError(msUntilNextOpen())`
4. Check mid-session break counter — if N messages sent since last break: `await sleep(randomBreakDuration())`
5. Call Claude to generate varied message body
6. `await sleep(gaussianDelay())` — human-like interval
7. Call `BrowserManager.sendMessage(phone, variedBody)`
8. Update `Message.status = SENT`, `sentAt = now()`
9. Increment `DailySendLog.count`
10. Emit SSE event to connected campaign listeners
11. Start delivery status polling for this message (background, 10s intervals, 3 min max)

**Worker runs as a separate process:**
```
node workers/message-worker.ts
```

In production: managed by `pm2` alongside the Next.js server.

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
// lib/scheduler.ts

const TIMEZONE = 'Asia/Jakarta'
const START_HOUR = 8   // 08:00
const END_HOUR = 17    // 17:00
const WORKING_DAYS = [1, 2, 3, 4, 5, 6]  // Mon–Sat (0=Sun)

function isWorkingHours(): boolean
function msUntilNextOpen(): number   // ms to delay if outside working hours
function gaussianDelay(): number     // Gaussian-jittered interval between sends
function randomBreakDuration(): number  // random 3–8 min mid-session break
```

Example: campaign enqueued at 16:55 WIB with 50 contacts:
- Messages 1–10 send from 16:55–17:00 (at ~35s avg intervals)
- Message 11: outside-hours check fires at 17:00 → delayed to 08:00 next working day
- UI shows: "Campaign paused — resumes 08:00 tomorrow"

---

## UI Pages

### `/` — Dashboard
- Cards: Total contacts, active campaigns, messages sent today, reply rate today, daily cap remaining
- Recent campaigns table (name, status, progress bar, reply rate)
- Browser status badge (connected / needs QR / disconnected)
- Live browser screenshot preview (thumbnail, refreshes every 5s via `/api/browser/screenshot`)

### `/import` — Import Contacts
- Folder tree of Department 1–9 → Areas
- Per-area: import button → shows parsed headers
- Claude suggests column mapping → user reviews + confirms
- Import progress: valid contacts / invalid phones / skipped duplicates
- Re-import replaces existing contacts for that area

### `/contacts` — Contact Browser
- Filter by Department, Area, phone validity
- Columns: Seq No, Store Name, Freezer ID, Phone (raw + normalized), Exchange Count
- Export to CSV button

### `/campaigns` — Campaign List
- Status badges: DRAFT / RUNNING / PAUSED / COMPLETED / CANCELLED
- Progress column: `sent/total` with mini progress bar
- Actions: View, Edit (draft only), Duplicate, Cancel

### `/campaigns/new` — Create Campaign
1. Name + `{{bulan}}` field (text input, e.g. "12")
2. Select target departments/areas (checkbox tree)
3. Message template editor with live preview (populates with first contact's data)
4. Contact count summary: X contacts selected, Y invalid phones excluded
5. Estimated duration based on Gaussian mean (35s avg) with working-hours split
6. Submit → status = DRAFT; separate "Start Campaign" button

### `/campaigns/[id]` — Campaign Detail
- Header: name, status, bulan, created date
- Progress ring: sent / delivered / read / failed / pending
- Live SSE feed updating counts in real-time
- Pause / Resume / Cancel buttons
- Mid-session break indicator (shows "on break — resumes in Xm Ys")
- Message table (paginated, filterable by status)
- Reply summary from Claude (confirmed X%, denied Y%, unclear Z%)

### `/responses` — Reply Inbox
- Table: Store Name | Area | Dept | Message Sent | Reply Text | Category | Sentiment | Time
- Filter: date range, category, sentiment, department, area
- Export to XLSX button (triggers `/api/export/responses`)
- "Write to output folder" button (triggers `/api/export/write`)

### `/settings` — Settings
- Browser section: live screenshot, status, "Open Browser" / "Close Browser" / "Reset Session" buttons
- QR code display (shown when WA Web needs re-authentication)
- Data folder path (reads from env, display only)
- Output folder path (reads from env, display only)
- Working hours: display only (from env)
- Rate limit: mean, stddev, min, max (display only)
- Daily cap: current count / cap (editable)
- Ramp-up schedule: display only

---

## Output File Format

Written to `OUTPUT_FOLDER/Department X/AreaName_responses.xlsx`:

| No | Nama Toko | No HP | Pesan Dikirim | Status | Waktu Kirim | Balasan | Kategori | Sentimen | Ringkasan | Waktu Balas |
|---|---|---|---|---|---|---|---|---|---|---|

Also written to `OUTPUT_FOLDER/responses_YYYY-MM-DD.xlsx` (consolidated daily log).

---

## Project File Structure

```
whatsapp-automation/
├── app/                            # Next.js 14 App Router
│   ├── (dashboard)/
│   │   ├── page.tsx                # Dashboard
│   │   ├── import/page.tsx         # Import + column mapping
│   │   ├── contacts/page.tsx
│   │   ├── campaigns/
│   │   │   ├── page.tsx
│   │   │   ├── new/page.tsx
│   │   │   └── [id]/page.tsx       # Live campaign detail
│   │   ├── responses/page.tsx
│   │   └── settings/page.tsx
│   └── api/
│       ├── browser/
│       │   ├── status/route.ts     # Browser + WA connection status
│       │   ├── screenshot/route.ts # Base64 screenshot
│       │   ├── start/route.ts      # Launch Playwright browser
│       │   └── stop/route.ts       # Close browser
│       ├── browser/events/route.ts # SSE — browser + delivery updates
│       ├── files/
│       │   ├── scan/route.ts       # Scan dept/area folder tree
│       │   ├── parse/route.ts      # SheetJS parse xlsx
│       │   └── import/route.ts     # Confirm mapping, save to DB
│       ├── campaigns/
│       │   ├── route.ts
│       │   └── [id]/
│       │       ├── route.ts
│       │       ├── enqueue/route.ts
│       │       ├── pause/route.ts
│       │       ├── resume/route.ts
│       │       ├── cancel/route.ts
│       │       ├── events/route.ts # SSE per-campaign
│       │       └── messages/route.ts
│       ├── analyze/
│       │   ├── headers/route.ts    # Claude Job 1: column mapping
│       │   ├── reply/route.ts      # Claude Job 2: reply analysis
│       │   └── vary/route.ts       # Claude Job 3: message variation
│       └── export/
│           ├── responses/route.ts
│           └── write/route.ts
├── lib/
│   ├── browser.ts                  # Playwright BrowserManager singleton
│   ├── human.ts                    # Ghost-cursor + typing simulation helpers
│   ├── excel.ts                    # SheetJS folder scanner + xlsx parser
│   ├── phone.ts                    # Indonesian phone normalizer + validator
│   ├── queue.ts                    # bullmq queue setup
│   ├── scheduler.ts                # Working hours, Gaussian delay, break logic
│   ├── claude.ts                   # Anthropic SDK wrapper (all 3 jobs)
│   ├── exporter.ts                 # Output xlsx writer
│   └── db.ts                       # Prisma client
├── workers/
│   └── message-worker.ts           # bullmq consumer (separate process)
├── prisma/
│   └── schema.prisma
├── spec/
│   └── SPEC.md                     # this file
├── .env.local
└── package.json
```

---

## Build Phases

### Phase 1 — Foundation
- Next.js 14 project scaffold with TypeScript, Tailwind, shadcn/ui
- Prisma schema + SQLite setup
- `.env.local` template
- Base layout: sidebar nav, header

### Phase 2 — Data Import
- `lib/excel.ts`: SheetJS folder scanner + xlsx parser
- `lib/phone.ts`: Indonesian phone normalizer + validator
- `lib/claude.ts`: Anthropic SDK wrapper — Job 1 (header mapping)
- `/api/files/scan`, `/api/files/parse`, `/api/analyze/headers`, `/api/files/import`
- Import UI page with column mapping confirmation

### Phase 3 — Browser Automation (Playwright)
- `lib/browser.ts`: BrowserManager singleton (launch, status, screenshot)
- `lib/human.ts`: ghost-cursor helpers, typing simulation, random pauses
- Playwright stealth setup with persistent browser profile
- `/api/browser/status`, `/api/browser/screenshot`, `/api/browser/start`, `/api/browser/stop`
- Settings page: screenshot preview, QR detection, browser controls
- SSE foundation for browser events

### Phase 4 — Queue + Scheduler + Reply Polling
- Redis connection setup
- `lib/queue.ts`: bullmq queue setup
- `lib/scheduler.ts`: working hours, Gaussian delay, mid-session break, daily cap
- `workers/message-worker.ts`: full worker with all safety checks + Claude variation
- DOM polling loop for reply detection in `lib/browser.ts`
- `/api/analyze/reply`, `/api/analyze/vary`

### Phase 5 — Campaigns
- Campaign CRUD API + UI
- New campaign form: template editor, dept/area selector, preview, bulan field
- Enqueue endpoint + SSE progress events
- Campaign detail page with live updates, break indicator
- Pause / Resume / Cancel controls
- Delivery status DOM polling (10s intervals, 3 min window)

### Phase 6 — Replies + Export
- Responses page with Claude category/sentiment display
- `lib/exporter.ts`: SheetJS xlsx writer
- `/api/export/responses`, `/api/export/write`
- Export buttons in UI

---

## Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| WhatsApp account ban | Visible browser, stealth plugin, Gaussian timing, daily cap, working hours, message variation, mid-session breaks |
| WhatsApp Web UI changes | Playwright selectors may break; DOM selectors abstracted into `lib/browser.ts` for easy updates |
| Browser crashes | BrowserManager auto-restarts on crash; bullmq jobs are durable (Redis-backed) |
| Inconsistent Excel headers | Claude-assisted mapping with user confirmation step |
| Messages sent outside hours | Worker's working-hours check + `DelayedError` reschedules to next 08:00 WIB |
| Daily cap exceeded | `DailySendLog` checked before every job; queue drains for the day |
| Invalid phone numbers | Validation at import time; invalid phones excluded from queue |
| Redis unavailable | bullmq startup check; clear error shown in UI |
| Session expired (QR needed) | Browser screenshot in Settings shows QR; user scans to re-auth |

---

## Notes

- The Playwright browser runs as a **visible Chromium window** on the machine running this app. It must not be minimized while campaigns are active (some WhatsApp Web features behave differently when the tab is hidden).
- All times are stored as UTC in SQLite. Timezone conversion to `Asia/Jakarta` happens in the scheduler and UI display layer.
- The bullmq worker runs as a **separate Node.js process** from the Next.js dev server. In production, manage both with `pm2` or Docker Compose.
- This project uses the WhatsApp Web interface via browser automation. It is against WhatsApp's Terms of Service. Use responsibly. For large-scale or commercial deployments, migrate to the official Meta WhatsApp Business API.
