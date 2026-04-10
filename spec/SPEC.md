# AICE WhatsApp Automation — Project Specification

## Overview

A full-stack web application for managing bulk WhatsApp messaging campaigns targeting AICE ice cream distribution partners. Reads contact data from `.xlsx` files organized by department and market area, sends personalized WhatsApp messages via real visible Chromium browsers controlled by Playwright (mimicking genuine human interaction to minimize ban risk), captures replies via DOM polling, analyzes them with Claude AI, writes results back to output Excel files, and auto-generates per-area CSV reports with binary confirmation answers (1 = confirmed, 0 = denied).

**Multi-agent:** The system supports N independent browser agents running in parallel. Each agent = one WhatsApp account + one Playwright Chromium window + one persistent browser profile. Agents share a single BullMQ message queue; the worker assigns jobs to agents using **round-robin rotation** (strict sequential cycling) to distribute sends evenly and minimise per-account volume. Agents can optionally be assigned to a specific department (agent-per-department mode) or float in a shared pool.

**Send targeting:** Each campaign has a configurable **target replies per area** and **expected reply rate**. At enqueue time the system calculates `sendLimit = ceil(targetReplies / replyRate)` per area and only queues that many contacts. Once an area's reply count hits the target, all remaining queued messages for that area are automatically cancelled — no wasted sends.

---

## Tech Stack

| Layer | Library/Tool | Version | Notes |
|---|---|---|---|
| Monorepo | pnpm workspaces | latest | 4 packages: shared, api, worker, web |
| API server | Express.js + TypeScript | latest | REST + SSE |
| Frontend | React + Vite + Tailwind CSS | latest | Port 5173 |
| Browser Automation | playwright | latest | Controls N real visible Chromium windows |
| Anti-Detection | Custom stealth init script | — | Removes headless/automation fingerprints via `addInitScript` |
| Excel Parsing | xlsx (SheetJS) | latest | Read `.xlsx`, inconsistent headers |
| AI | @anthropic-ai/sdk / @google/generative-ai | latest | Multi-provider: Anthropic (default) or Gemini. Controlled via `LLM_PROVIDER` env var. Header mapping, reply analysis, message variation |
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
│   ├── worker/          # BullMQ worker — owns all Playwright browsers via AgentManager
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
| `@aice/shared` | Shared TypeScript interfaces (MessageJob, PhoneCheckJob, CampaignStatus, AgentStatus, AgentInfo, SSE event types, etc.) |
| `@aice/api` | Express routes, lib utilities (excel, phone, claude, queue producer, exporter, report), Prisma schema |
| `@aice/worker` | BullMQ consumers (message + phone-check), AgentManager (N BrowserAgent instances), scheduler, Claude variation |
| `@aice/web` | React SPA — all UI pages, Vite proxy to API |

> **AgentManager ownership**: All Playwright browsers run inside `@aice/worker` under `AgentManager`. The API reads per-agent status from Redis. Browser control commands (start/stop) are sent via Redis pub/sub from API → worker, keyed per agent (`browser:command:{agentId}`).

---

## Environment Variables (`.env`)

```env
# ─── LLM Provider ─────────────────────────────────────────────────────────────
# Options: anthropic, openai, gemini (default: anthropic if not set)
LLM_PROVIDER=gemini

# ─── Anthropic (used when LLM_PROVIDER=anthropic) ─────────────────────────────
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-4.5-haiku

# ─── Google Gemini (used when LLM_PROVIDER=gemini) ────────────────────────────
GOOGLE_API_KEY=your-api-key
GEMINI_MODEL=gemini-2.0-flash

# ─── Data paths ───────────────────────────────────────────────────────────────
DATA_FOLDER=/absolute/path/to/data          # root folder containing Department 1..9
OUTPUT_FOLDER=/absolute/path/to/output      # where response files are written

# ─── Database ─────────────────────────────────────────────────────────────────
DATABASE_URL=mysql://root@localhost:3306/wa_automation

# ─── Redis ────────────────────────────────────────────────────────────────────
REDIS_URL=redis://localhost:6379

# ─── Browser automation ───────────────────────────────────────────────────────
BROWSER_PROFILE_PATH=./browser-profile      # base directory for all agent profiles; each agent's profile lives at {BROWSER_PROFILE_PATH}/{agentId}/
BROWSER_HEADLESS=false                      # always false — visible windows required

# ─── Working hours (WIB = Asia/Jakarta, UTC+7) ────────────────────────────────
WORKING_HOURS_START=08:00
WORKING_HOURS_END=17:00
WORKING_DAYS=1,2,3,4,5,6                   # 1=Monday … 7=Sunday
TIMEZONE=Asia/Jakarta

# ─── Rate limiting (Gaussian distribution — not mechanical fixed interval) ─────
RATE_LIMIT_MEAN_MS=35000                    # mean 35 seconds between messages
RATE_LIMIT_STDDEV_MS=8000                   # std deviation ±8 seconds
RATE_LIMIT_MIN_MS=20000                     # hard floor — never faster than 20s
RATE_LIMIT_MAX_MS=90000                     # hard ceiling — never slower than 90s

# ─── Safety caps & timing — global defaults, all overridable per agent in the Agents UI
DAILY_SEND_CAP=150                          # max messages per day per agent
MID_SESSION_BREAK_EVERY=30                  # pause after every N messages
MID_SESSION_BREAK_MIN_MS=180000             # min break duration (3 min)
MID_SESSION_BREAK_MAX_MS=480000             # max break duration (8 min)

# ─── Typing speed ─────────────────────────────────────────────────────────────
TYPE_DELAY_MIN_MS=80                        # fastest keystroke delay (ms)
TYPE_DELAY_MAX_MS=180                       # slowest keystroke delay (ms)

# ─── Reply polling ────────────────────────────────────────────────────────────
REPLY_POLL_INTERVAL_MS=60000               # scan WA Web for new replies every 60s (per agent)
CAMPAIGN_REPLY_WINDOW_DAYS=3               # accept late replies for N days after campaign completes (default: 3)

# ─── Phone check parallelism ──────────────────────────────────────────────────
PHONE_CHECK_CONCURRENCY=3                  # how many phone-check jobs run in parallel

# ─── API server ───────────────────────────────────────────────────────────────
PORT=3001

# ─── Web (Vite — must be prefixed VITE_) ──────────────────────────────────────
VITE_API_URL=http://localhost:3001
```

> **Note**: `BROWSER_PROFILE_PATH` is the base directory for all agent profiles. Each agent's profile is auto-created at `{BROWSER_PROFILE_PATH}/{agentId}/` — no manual path entry needed when creating agents. `BROWSER_PROFILES_DIR` is accepted as an alias.

### Startup Validation

Both `@aice/api` and `@aice/worker` run a startup validation before accepting traffic:

1. **Environment variables** — checks all required vars are present and not placeholder values
2. **LLM provider** — validates the active provider's API key:
   - `anthropic`: `ANTHROPIC_API_KEY` must start with `sk-ant-`
   - `gemini`: `GOOGLE_API_KEY` must be present
3. **DATABASE_URL format** — must start with `mysql://`
4. **MySQL connection** — `SELECT 1` query
5. **Redis connection** — `PING`
6. **DATA_FOLDER exists** (API only)
7. **BROWSER_PROFILE_PATH exists or is creatable** (worker only)

Process exits with code 1 and a clear error summary if any check fails.

---

## Data Source Structure

```
data/
├── STIK/
│   ├── Department 1/
│   │   ├── Aceh Barat.xlsx
│   │   ├── Aceh Utara.xlsx
│   │   └── ...
│   ├── Department 2/
│   │   └── ...
│   └── ...
└── KARDUS/
    ├── Department 1/
    │   ├── Aceh Barat.xlsx
    │   └── ...
    └── ...
```

The top-level subfolder name (`STIK` / `KARDUS`) is the **contact type**. The folder scanner reads it as the type and passes it through to the import flow. All contacts imported from a type subfolder are tagged with that `contactType`.

> Additional types can be supported in the future by adding new top-level subfolders — no code changes required beyond updating the allowed-values list.

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

## Duplicate Phone Numbers (STIK × KARDUS)

The same phone number can appear in both the STIK and KARDUS import files for the same area. This is expected — a store owner may exchange both product types. The system handles duplicates at three points:

### At import
`Area.contactType` differentiates the two records. `Contact.@@unique([areaId, phoneNorm])` — since the STIK area and KARDUS area have different `areaId`s, the same phone imports cleanly as two independent Contact records with no conflict.

### At WA registration check
`POST /api/contacts/validate-wa` deduplicates by `phoneNorm` before enqueuing jobs — one Playwright navigation per unique phone, never two. The worker writes the result with `updateMany({ where: { phoneNorm } })`, so both the STIK and KARDUS contact records are updated in a single DB write.

### At reply detection
When a phone replies, `handleReply` finds **all** unreplied messages for that phone — spanning both STIK and KARDUS campaigns if applicable. Claude is called **once** with the reply text. The same `{ jawaban, category, sentiment, summary }` is written to every Reply record created in that fan-out. Each affected campaign and area report is then updated independently.

| Scenario | Result |
|---|---|
| Same phone, STIK and KARDUS both sent, store replies once | Both messages get a Reply record with the same text + jawaban. Both CSV reports updated. |
| Same phone, only STIK sent so far | Only the STIK message gets a Reply. KARDUS stays unreplied until KARDUS send happens. |
| Same phone, store replies twice (one per campaign) | First reply fans out to all unreplied at that moment. Second reply fans out to whatever remains unreplied. |
| Screenshot | One screenshot per poll visit. Same path referenced in all Reply records from that poll. |

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

Phone-check jobs are dispatched through `AgentManager.getLeastBusyAgent()` — the same agent-selection logic used for sends. Any online agent can perform a phone check.

### Automatic invalidation during send

If `sendMessage` encounters the "Nomor tidak terdaftar" popup during a live campaign, the worker:
1. Dismisses the popup
2. Marks `message.status = FAILED` with `failReason`
3. **Also** updates the contact: `phoneValid = false, waChecked = true`

This ensures the contact is excluded from all future campaigns without needing a manual re-validation.

### Browser lock (per agent)

All browser operations (`sendMessage`, `checkPhoneRegistered`, `pollReplies`) are serialised through a `_withBrowserLock` mutex **on each `BrowserAgent` instance**. Only one operation runs at a time per agent — the rest queue and run in order after the current one finishes. Different agents operate concurrently with no shared lock.

**Blocking behaviour (by design):**

| Scenario | Result |
|---|---|
| Poll fires while `sendMessage` is running | Poll waits. Send completes fully (navigate → type → click send). Then poll runs. |
| Send job queued while `pollReplies` is running | Send waits. Poll visits all unreplied phones, then releases lock. Send runs normally. |
| `checkPhoneRegistered` queued behind a send | Same — waits, then runs after send releases. |

This is intentional: the Playwright page can only be in one place at a time. Serialisation ensures the page is never navigated away mid-send, mid-type, or mid-poll. All operations complete cleanly before the next one starts.

---

## Message Template

Static per-campaign template with variable substitution. Variables use `{{variable_name}}` syntax.

### Default Templates (per campaign type)

The UI pre-fills the template based on the selected campaign type. The user can edit freely after selection.

**STIK:**
```
Halo bapak/ibu mitra aice {{area}} toko {{nama_toko}}, saya dari tim inspeksi aice pusat Jakarta ingin melakukan konfirmasi. Apakah benar bahwa pada bulan {{bulan}} toko bapak/ibu telah melakukan penukaran Stik ke distributor?
```

**KARDUS:**
```
Halo bapak/ibu mitra aice {{area}} toko {{nama_toko}}, saya dari tim inspeksi aice pusat Jakarta ingin melakukan konfirmasi. Apakah benar bahwa pada bulan {{bulan}} toko bapak/ibu telah melakukan penukaran kupon Kardus ke distributor?
```

> The templates differ in phrasing (not just a word swap), so two separate defaults are used rather than a single `{{tipe}}` variable. Switching campaign type in the create form updates the template automatically — unless the user has already manually edited it.

### Available Variables

| Variable | Source |
|---|---|
| `{{nama_toko}}` | `store_name` from Excel |
| `{{bulan}}` | Campaign-level static field (user sets once, e.g. `"12"` or `"Desember"`) |
| `{{department}}` | Department name |
| `{{area}}` | Area / market name |
| `{{tipe}}` | Campaign type, title-cased — `"Stik"` or `"Kardus"` |

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

model Agent {
  id             Int           @id @default(autoincrement())  // readable integer: 1, 2, 3
  name           String        @unique
  profilePath    String        @db.VarChar(500)  // auto-derived: {BROWSER_PROFILE_PATH}/{id}
  phoneNumber    String        // WhatsApp number — required at creation
  status         String        @default("OFFLINE") // OFFLINE|STARTING|ONLINE|QR|ERROR
  // Per-agent behaviour overrides — null = use the global .env default
  dailySendCap   Int?          // max messages per day       (null = DAILY_SEND_CAP env, default 150)
  breakEvery     Int?          // pause after N messages     (null = MID_SESSION_BREAK_EVERY env)
  breakMinMs     Int?          // min break duration ms      (null = MID_SESSION_BREAK_MIN_MS env)
  breakMaxMs     Int?          // max break duration ms      (null = MID_SESSION_BREAK_MAX_MS env)
  typeDelayMinMs Int?          // min keystroke delay ms     (null = TYPE_DELAY_MIN_MS env, default 80)
  typeDelayMaxMs Int?          // max keystroke delay ms     (null = TYPE_DELAY_MAX_MS env, default 180)
  departmentId   String?       // optional — if set, prefer this agent for dept contacts
  department     Department?   @relation(fields: [departmentId], references: [id], onDelete: SetNull)
  messages       Message[]
  dailySendLogs  DailySendLog[]
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt
}

model Department {
  id        String    @id @default(cuid())
  name      String    @unique
  path      String    @db.VarChar(500)
  areas     Area[]
  contacts  Contact[]
  agents    Agent[]
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}

model Area {
  id            String         @id @default(cuid())
  name          String
  contactType   String         // "STIK" | "KARDUS" — inferred from DATA_FOLDER top-level subfolder
  fileName      String
  filePath      String         @db.VarChar(500)
  columnMapping Json?                          // Claude-mapped column keys
  departmentId  String
  department    Department     @relation(fields: [departmentId], references: [id], onDelete: Cascade)
  contacts      Contact[]
  campaigns     CampaignArea[]
  createdAt     DateTime       @default(now())
  updatedAt     DateTime       @updatedAt

  @@unique([departmentId, name, contactType])  // Aceh Barat STIK ≠ Aceh Barat KARDUS
}

model Contact {
  id            String     @id @default(cuid())
  seqNo         String?
  storeName     String
  freezerId     String?
  phoneRaw      String
  phoneNorm     String
  contactType   String     // "STIK" | "KARDUS" — denormalized from area.contactType for fast filtering
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

  // areaId already encodes the type (STIK area ≠ KARDUS area for same market),
  // so the same phone can exist once per type within the same market.
  @@unique([areaId, phoneNorm])
}

model Campaign {
  id             String         @id @default(cuid())
  name           String
  template       String         @db.Text
  bulan          String
  status         String         @default("DRAFT") // DRAFT|RUNNING|PAUSED|COMPLETED|CANCELLED

  campaignType          String  // "STIK" | "KARDUS" — determines which contacts are enqueued

  // Send targeting — null means "use global AppConfig default at enqueue time"
  targetRepliesPerArea  Int?    // desired replies per area (e.g. 20)
  expectedReplyRate     Float?  // expected reply rate 0.0–1.0 (e.g. 0.5)
  stopOnTargetReached   Boolean @default(true)  // cancel remaining msgs once area hits target

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
  campaignId    String
  areaId        String
  campaign      Campaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  area          Area     @relation(fields: [areaId], references: [id], onDelete: Cascade)

  // Populated at enqueue time
  sendLimit     Int?     // max contacts enqueued for this area: ceil(targetReplies / replyRate)
  sentCount     Int      @default(0)   // messages successfully sent for this area
  replyCount    Int      @default(0)   // replies received for this area
  targetReached Boolean  @default(false) // true once replyCount >= campaign.targetRepliesPerArea

  @@id([campaignId, areaId])
}

model Message {
  id          String    @id @default(cuid())
  campaignId  String
  campaign    Campaign  @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  contactId   String
  contact     Contact   @relation(fields: [contactId], references: [id], onDelete: Cascade)
  agentId     String?   // which agent sent this message (null = not yet sent)
  agent       Agent?    @relation(fields: [agentId], references: [id], onDelete: SetNull)
  phone       String
  body        String    @db.Text
  status      String    @default("PENDING") // PENDING|QUEUED|SENT|DELIVERED|READ|FAILED|CANCELLED
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
  agentId   Int
  agent     Agent    @relation(fields: [agentId], references: [id], onDelete: Cascade)
  date      String   // "YYYY-MM-DD" in WIB
  count     Int      @default(0)
  updatedAt DateTime @updatedAt

  @@unique([agentId, date])  // each agent tracks its own daily count independently
}

// Singleton row (id = "singleton") — stores global UI-configurable defaults
model AppConfig {
  id                          String   @id @default("singleton")
  defaultTargetRepliesPerArea Int      @default(20)   // target replies per area per campaign
  defaultExpectedReplyRate    Float    @default(0.5)  // 0.0–1.0 (e.g. 0.5 = 50%)
  updatedAt                   DateTime @updatedAt
}
```

---

## API Routes

### App Configuration

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/config` | Get global app config (defaultTargetRepliesPerArea, defaultExpectedReplyRate, computed defaultSendPerArea) |
| `PATCH` | `/api/config` | Update global app config. Body: `{ defaultTargetRepliesPerArea?, defaultExpectedReplyRate? }` |

`defaultSendPerArea` is a **computed field** returned by `GET /api/config`:
```
defaultSendPerArea = ceil(defaultTargetRepliesPerArea / defaultExpectedReplyRate)
```

### Agents

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/agents` | List all agents with status, active job count, daily send count |
| `POST` | `/api/agents` | Register a new agent. Body: `{ name, phoneNumber, dailySendCap?, breakEvery?, breakMinMs?, breakMaxMs?, typeDelayMinMs?, typeDelayMaxMs?, departmentId? }`. `phoneNumber` required. All timing fields optional — null uses env default. `profilePath` auto-derived as `{BROWSER_PROFILE_PATH}/{agentId}`. |
| `GET` | `/api/agents/:id` | Single agent detail |
| `PATCH` | `/api/agents/:id` | Update agent name or department assignment |
| `DELETE` | `/api/agents/:id` | Remove agent (must be OFFLINE) |
| `GET` | `/api/agents/:id/status` | Live status from Redis |
| `GET` | `/api/agents/:id/screenshot` | Current screenshot as base64 |
| `POST` | `/api/agents/:id/start` | Send start command via Redis pub/sub |
| `POST` | `/api/agents/:id/stop` | Send stop command via Redis pub/sub |
| `GET` | `/api/agents/:id/events` | SSE stream — status changes for this agent |

### Browser / WhatsApp Session (aggregate)

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/browser/status` | Aggregate status: `{ agents: AgentStatus[], anyOnline: boolean }` |
| `GET` | `/api/browser/events` | SSE stream — all agents' status changes + delivery updates + reply notifications |

### Files / Import

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/files/scan` | Scan DATA_FOLDER, return `type → dept → area` tree. Response includes `contactType` on each area node. |
| `GET` | `/api/files/areas` | Return imported areas from DB grouped by `contactType → department`. Each area includes `contactType`. |
| `POST` | `/api/files/parse` | Parse a single xlsx, return headers + sample rows |
| `POST` | `/api/analyze/headers` | Send headers+samples to Claude, get column mapping suggestion |
| `POST` | `/api/files/import` | Confirm mapping, normalize phones, save to DB. Body must include `contactType` (inferred from folder path by the UI). |

### Contacts

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/contacts` | List contacts (filter: dept, area, phoneValid, waChecked, **search**). `search` query param performs case-insensitive substring match against `storeName`, `phoneRaw`, and `phoneNorm` (OR). |
| `GET` | `/api/contacts/:id` | Single contact detail |
| `POST` | `/api/contacts/:id/validate-wa` | Queue a **single contact's phone** for WA registration check (or re-check). Enqueues one job for the contact's `phoneNorm`, sets the Redis checking flag. Used by the per-row "Validasi" / "Cek Ulang" button in the contacts table. |
| `POST` | `/api/contacts/validate-wa` | Queue WA registration checks. Body: `{ areaIds?[], recheckAreaIds?[], areaId?, limitPerArea?, limit?, recheck? }`. Supports **multi-area selection** via `areaIds` array. `recheckAreaIds` is for already-validated areas that the user wants to re-check (all phones). `limitPerArea` caps contacts queued per area. Contacts are **deduplicated by `phoneNorm`** before enqueuing — one job per unique phone number regardless of how many Contact records share it (STIK + KARDUS same phone = one Playwright check). Default: only unchecked contacts. `recheck: true` re-checks all. |
| `GET` | `/api/contacts/validate-wa/count` | Returns **all areas** with per-area counts: `{ unchecked, areaCount, areas: [{ areaId, name, contactType, unchecked, validated, registered, invalid, total }] }`. Includes fully-validated areas (unchecked=0) so the modal can show them as re-checkable. `registered` = confirmed on WA, `invalid` = bad format or not on WA. |
| `GET` | `/api/contacts/validate-wa/status` | Live phone-check queue counts: `{ waiting, active, completed, failed, total }` |

### Campaigns

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/campaigns` | List all campaigns. Each campaign includes `alreadyRepliedCount` — unique contacts who replied in **any** campaign with the same `bulan` + `campaignType`, grouped by area and **capped at `targetRepliesPerArea` per area** (excess replies beyond target are ignored). |
| `POST` | `/api/campaigns` | Create new campaign. Body includes `targetRepliesPerArea?`, `expectedReplyRate?` (null = use global defaults) |
| `GET` | `/api/campaigns/:id` | Get campaign detail + stats + per-area breakdown (`CampaignArea` with sendLimit, sentCount, replyCount, targetReached) |
| `PATCH` | `/api/campaigns/:id` | Update campaign (draft only) |
| `DELETE` | `/api/campaigns/:id` | Delete campaign (draft only) |
| `POST` | `/api/campaigns/:id/enqueue` | Enqueue contacts. Body: `{ contactIds?: string[] }` — if provided, only enqueue those contacts; otherwise auto-select up to `sendLimit` per area. Returns per-area preview: `{ areaId, areaName, available, willSend, target }[]` |
| `GET` | `/api/campaigns/:id/contacts` | Returns up to 100 eligible contacts per area for the contact picker. Each contact includes `alreadyReplied: boolean` — true if they already have a reply in any campaign with the same `bulan` + `campaignType`. |
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
| `GET` | `/api/export/report-xlsx?campaignId=` | Download per-campaign XLSX — one sheet per area, screenshots in column E. Filename: `{Type}_{Bulan}_{YYYY-MM-DD}.xlsx` |

---

## Browser Automation (Playwright)

### Architecture

The Playwright browsers run as **long-lived instances** managed by `AgentManager` inside the worker process. Each `BrowserAgent` is launched independently and kept alive for its session.

```
packages/worker/src/lib/agent-manager.ts
  └── AgentManager
        ├── agents: Map<agentId, BrowserAgent>
        ├── initFromDB()             — loads agents from DB at startup, starts ONLINE ones
        ├── getLeastBusyAgent()      — returns the ONLINE agent with lowest activeJobCount
        ├── startAgent(agentId)      — launches BrowserAgent, publishes status to Redis
        ├── stopAgent(agentId)       — gracefully closes BrowserAgent
        └── handleCommand(agentId, cmd) — responds to Redis pub/sub commands

packages/worker/src/lib/browser-agent.ts
  └── BrowserAgent (one per WhatsApp account)
        ├── agentId: string
        ├── profilePath: string
        ├── activeJobCount: number   — tracked in-memory and in Redis
        ├── launch()                 — starts Chromium with persistent profile + stealth
        ├── getPage()                — returns active WhatsApp Web page
        ├── sendMessage()            — full human-simulation send flow (agent-locked)
        ├── checkPhoneRegistered()   — Promise.race compose/popup detection (agent-locked)
        ├── pollReplies()            — DOM scan for unread chats
        ├── getStatus()              — connected | qr | loading | disconnected
        ├── screenshot()             — base64 screenshot for UI preview
        └── _withBrowserLock()       — per-agent mutex serialising all page interactions
```

The API reads per-agent status from Redis keys `agent:{agentId}:status`. Agent control commands travel from API → Redis pub/sub channel `browser:command:{agentId}` → AgentManager → BrowserAgent.

### Agent Selection (round-robin, cap-aware)

```
1. Fresh status check: call getStatus() on ALL agents in parallel (forces a live DOM check
   so banned/disconnected agents are excluded immediately — not relying on the 15s poll cache)
2. Collect all agents where status = "connected", sorted by agentId ascending (stable order)
3. If MessageJob.agentId is set (department affinity), move that agent to front of list
4. Starting from a persistent round-robin index, iterate candidates in sequence:
   — query DailySendLog — skip if today's count >= agent.dailySendCap
   — use the first candidate still under its cap
   — advance round-robin index to the next position
5. If no agents are ONLINE: poll every 10s, up to 10 min, then fail the job
6. If all ONLINE agents are at their cap: reschedule job via job.moveToDelayed(msUntilNextOpen())
```

The round-robin index persists across jobs (resets on worker restart). This ensures each agent takes turns in strict sequence — e.g. with agents A, B, C: job 1 → A, job 2 → B, job 3 → C, job 4 → A, etc. This distributes sends evenly and minimises per-account volume, reducing WhatsApp ban risk compared to random selection where one agent could be unlucky and get disproportionate load.

`activeJobCount` is incremented when a job is assigned to an agent and decremented when the job finishes (success or failure).

### Department-Affinity Routing

When `MessageJob.agentId` is set (because the contact's department has an assigned agent):
1. Check if that agent is ONLINE and under its daily cap — if yes, use it directly
2. Otherwise fall back to the cap-aware pool selection above

This allows agent-per-department assignment while gracefully degrading to pool routing if the preferred agent is offline.

### Browser Launch Config (per agent)

```ts
this.context = await chromium.launchPersistentContext(this.profilePath, {
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

### Reply Detection (DOM Polling, per agent)

A background loop runs per agent every `REPLY_POLL_INTERVAL_MS` (60s):

```
1. Query DB: find all phones with SENT/DELIVERED/READ messages and no Reply record yet
   → includes RUNNING/PAUSED campaigns + COMPLETED campaigns within CAMPAIGN_REPLY_WINDOW_DAYS
   → COMPLETED campaigns older than the window and all CANCELLED campaigns are excluded
   → returns Map<phone, sentAt>   (earliest sentAt per phone)

2. For each phone in the map:
   a. Navigate to https://web.whatsapp.com/send?phone={number}
   b. Wait for chat to load (compose box visible, max 20s)

   c. Position-based anchor — prevents old chat history from being mistaken as a reply:
      - Collect all message rows in DOM order (= chronological order)
      - Find the LAST .message-out row (our most recent sent campaign message) → anchor
      - If no .message-out found → our message not in view yet → skip this phone
      - Collect all .message-in rows that appear strictly AFTER the anchor
      - If none → contact hasn't replied yet → skip this phone
      - Take the LAST incoming after the anchor as the reply text
        (handles follow-up messages: if contact sends "iya" then "sudah dikonfirmasi",
         takes "sudah dikonfirmasi" — Claude can still classify it correctly)

   d. Take a **cropped screenshot of the chat panel only** (`#main` element);
      falls back to full-page if element not found.
      Saved to `OUTPUT_FOLDER/screenshots/{phone}_{timestamp}.jpg`

   e. Fan-out: find ALL unreplied messages for this phone (covers STIK + KARDUS),
      call Claude ONCE, create Reply records for each message

   f. Trigger CSV report for each affected (areaId, bulan, campaignType)
```

**Why position-based instead of timestamp-based:**
WhatsApp Web renders messages in chronological order top-to-bottom. Finding the last `.message-out` and reading only `.message-in` elements after it is reliable across all WhatsApp Web versions, doesn't require parsing locale-dependent timestamp strings, and handles pre-existing chat history correctly.

| Scenario | Result |
|---|---|
| Old chat exists, no new reply | Last `.message-out` is anchor; nothing after it → skipped |
| Old chat exists, contact replied | Incoming after anchor found → correct reply captured |
| Contact sends follow-up after reply | Takes last incoming after anchor → handled correctly |
| Our message not yet visible in DOM | No `.message-out` found → skipped safely |

---

## Reply Analysis & CSV Report

### Flow

```
Worker detects reply (phone + text + screenshotPath)
  → find ALL unreplied messages for this phone
    (status IN SENT/DELIVERED/READ, no Reply record yet)
    — may be >1 if same phone has both STIK and KARDUS unreplied messages
  → create one Reply record per unreplied message (same body + screenshotPath)
  → call Claude ONCE with the reply text
  → write { claudeCategory, sentiment, summary, jawaban } to ALL reply records
  → for each affected message:
      → increment Campaign.replyCount
      → generateAreaReport(areaId, bulan, campaignType) — fire-and-forget
        (bulan from message.campaign.bulan, contactType from message.contact.area.contactType)
```

**Why fan-out instead of attributing to the most recent message only:**
The same phone number can have unreplied messages in both a STIK campaign and a KARDUS campaign. One reply from the store owner answers both — the jawaban (1/0) is product-agnostic. Attributing to all unreplied messages ensures both reports are complete without requiring the store to reply twice.

**Why call Claude once:**
Same reply text + same question context → same classification result every time. Calling Claude per reply record would be redundant and wasteful.

### Jawaban determination

`jawaban` is determined entirely by Claude (Job 2). No keyword matching. Claude returns `jawaban` directly in its JSON response alongside `category`, `sentiment`, and `summary`.

| Claude `jawaban` | Meaning |
|---|---|
| `1` | Store confirmed they did the exchange (Ya/confirmed) |
| `0` | Store denied the exchange (Tidak/denied) |
| `null` | Unclear, question, or off-topic — excluded from CSV report |

Claude handles all informal Indonesian variations: "iya", "betul", "sudah", "ada" → 1; "tidak", "belum", "ngga", "gak", "blm", "ndak" → 0.

### CSV Output Format

Written to `OUTPUT_FOLDER/{Type}/{Department Name}/{Area Name}_{Bulan}_{YYYY-MM-DD}.csv`

- `{Type}` = "STIK" or "KARDUS" (from `area.contactType`)
- `{Bulan}` = campaign's `bulan` value (e.g. "Januari" or "01") — scopes the report to one month
- Date suffix shows when the file was last generated. Same date = overwritten. New date = new file alongside previous ones.

Because a market (area) can appear in both STIK and KARDUS campaigns and in multiple months, **each combination is a separate file**. The `generateAreaReport` function signature becomes `generateAreaReport(areaId, bulan, campaignType)`.

```csv
Nama Toko,Nomor HP Toko,Department,Area,Agent Phone,Jawaban,Screenshot
Toko ABC,+628121234567,Department 1,Aceh Barat,+628551234567,1,/path/to/output/screenshots/628121234567_2026-03-14T08-30-00.jpg
Toko XYZ,+628121234568,Department 1,Aceh Barat,+628551234567,0,/path/to/output/screenshots/628121234568_2026-03-14T09-15-00.jpg
Toko DEF,+628121234569,Department 1,Aceh Barat,+628551234567,,
```

**Column notes:**
- `Agent Phone` — WhatsApp number of the agent that sent this message
- `Jawaban` — `1` (confirmed), `0` (denied), or **blank** (sent but not yet replied)
- `Screenshot` — absolute path to the `.jpg` file; blank until a reply is received

**Trigger — two events regenerate the report:**

| Event | Effect |
|---|---|
| Message **sent** | Contact row added immediately with blank Jawaban and Screenshot |
| Reply **analyzed** | Same row updated with Jawaban (1/0) and Screenshot path |

- Includes **all contacts who were sent a message** — not just those who replied
- Fully rewritten on each trigger (idempotent)
- Screenshots are **cropped to the chat panel only** (`#main` element), full-page fallback
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
  phone: string      // +62...
  body: string       // rendered message (pre-variation)
  agentId?: string   // preferred agent (set if dept has assigned agent); worker falls back to pool
}
```

**Worker logic (per job):**
1. Verify message exists in DB AND `status != 'CANCELLED'` — skip silently if missing or cancelled
2. Resolve agent (round-robin, cap-aware):
   - Collect all ONLINE agents sorted by `agentId` (stable order); if `agentId` is set, move that agent to front
   - Starting from a persistent round-robin index, iterate candidates in sequence
   - For each candidate, query `DailySendLog` — skip agents where today's count >= `agent.dailySendCap`
   - Use the first candidate still under its cap; advance round-robin index
   - If no agents are online: poll every 10s, up to 10 min, then fail the job
   - If all online agents have hit their cap: reschedule job via `job.moveToDelayed(msUntilNextOpen())` and return — **no sleeping inside the job**
3. Increment `agent:{agentId}:active_jobs` in Redis
4. Check current time in `Asia/Jakarta` — if outside working hours: reschedule via `job.moveToDelayed(msUntilNextOpen())` and return — **no sleeping inside the job**
5. Check mid-session break counter (per agent) — if `agent.breakEvery` messages since last break: sleep `agent.breakMinMs`–`agent.breakMaxMs` random duration
6. `await sleep(gaussianDelay())` — human-like interval
7. Call Claude to generate varied message body (Job 3)
8. Call `agent.sendMessage(phone, variedBody)` — agent-locked; chat-load wait is attempt-aware:
   - attempt #1 uses 15000ms timeout
   - attempt #2 (retry) uses half of attempt #1 timeout (7500ms, fail-fast)
9. Update `Message.status = SENT`, `sentAt = now()`, `agentId = agent.id`, and clear stale failure fields:
   - `failedAt = null`
   - `failReason = null`
10. Increment `DailySendLog.count` for this agent
11. Increment `Campaign.sentCount`
12. Decrement `agent:{agentId}:active_jobs` in Redis

**On failure (terminal, after retries exhausted):**
- Mark `Message.status = FAILED`, store `failReason` + `failedAt`
- If `failReason` contains `"tidak terdaftar"`: also set `contact.phoneValid = false, waChecked = true`
- Always decrement `agent:{agentId}:active_jobs`

**Retry:** 2 total attempts (1 initial + 1 retry) with exponential backoff (5s base).

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
1. Call `agentManager.getValidationAgent()` — prefers validation-only agents; falls back to `getLeastBusyAgent()` if none online. Polls every 5s, max 5 min.
2. Increment `agent.activeJobCount`
3. Call `agent.checkPhoneRegistered(phone)` — agent-locked via `_withBrowserLock()`
4. Update **all contacts** sharing that `phoneNorm` — one result propagates to both STIK and KARDUS records:
   ```ts
   db.contact.updateMany({ where: { phoneNorm: phone }, data: { phoneValid: registered, waChecked: true } })
   ```
5. Decrement `agent.activeJobCount`

**Concurrency:** `PHONE_CHECK_CONCURRENCY` (default 3) — multiple agents validate in parallel, each behind its own browser lock.

**No retries** (attempts: 1) — a failed check is simply not recorded; all contacts with that phone stay `waChecked: false` and can be re-queued.

**Queued by:** `POST /api/contacts/validate-wa` — accepts `areaIds[]` for normal unchecked areas and `recheckAreaIds[]` for already-validated areas to re-check. Both support `limitPerArea` cap per area. Contacts from both sets are combined, deduplicated by `phoneNorm` before enqueuing, so the same phone number is never checked twice even if it appears in both STIK and KARDUS imports.

---

## Send Targeting

### Goal

Reach a **target number of replies per area** without wasting sends on contacts who won't respond. The system calculates how many messages to send per area based on an expected reply rate, and stops early once the target is met.

### Configuration hierarchy

```
AppConfig.defaultTargetRepliesPerArea  ← global default (editable in Settings UI)
AppConfig.defaultExpectedReplyRate

        overridden by

Campaign.targetRepliesPerArea          ← per-campaign override (set at creation)
Campaign.expectedReplyRate
```

At runtime, the effective values are resolved as:
```ts
const target = campaign.targetRepliesPerArea ?? appConfig.defaultTargetRepliesPerArea
const rate   = campaign.expectedReplyRate     ?? appConfig.defaultExpectedReplyRate
const limit  = Math.ceil(target / rate)       // e.g. ceil(20 / 0.5) = 40
```

### Enqueue logic (per area)

At `POST /api/campaigns/:id/enqueue`:

```
For each area in the campaign:
  1. Resolve effective target and rate (campaign override ?? global default)
  2. sendLimit = ceil(target / rate)
  3. contacts = query contacts where:
       - areaId = this area
       - contactType = campaign.campaignType   ← only enqueue matching type
       - phoneValid = true
       - waChecked = true
       - NOT already enqueued in this campaign
     ORDER BY createdAt ASC
     LIMIT sendLimit
  4. Create Message records (status=PENDING) + add to BullMQ queue
  5. Set CampaignArea.sendLimit = sendLimit
  6. Update Campaign.totalCount += contacts.length
```

If an area has fewer valid contacts than `sendLimit`, all available contacts are enqueued — the target may not be reached, but the system sends what it has.

### Top-up (manual)

After the initial batch is fully sent, replies arrive over the following day(s). If after waiting the reply count is still short of the target, the user can manually trigger a **top-up** from the campaign detail page.

**`POST /api/campaigns/:id/topup`** — Body: `{ areaId? }` (omit to top-up all eligible areas)

Logic per area:
1. Skip if `targetReached = true`
2. Skip if there are still PENDING/QUEUED messages for this area (batch not finished yet)
3. Query the next batch of fresh contacts (`contactType = campaignType`, `phoneValid`, `waChecked`, not yet messaged in this campaign), up to `sendLimit` contacts
4. Create Message records + enqueue jobs
5. Increment `CampaignArea.sendLimit` and `Campaign.totalCount`
6. Return per-area result: `{ enqueued, skipped? }`

**UI — per-area table:**

| Status badge | Meaning |
|---|---|
| `Running` (blue) | Batch still in progress |
| `Short by N` (yellow) | All sent, replies < target — user may top up when ready |
| `Target reached` (green) | Reply target met, no further sends needed |

The "Short by N" badge appears as soon as the batch is fully sent and target is not reached. There is **no automatic waiting period** — the user decides when to top up based on how long they want to wait for replies.

Both a per-area **Top-up** button and a **"Top-up all areas"** button (header of the table) are shown while the campaign is RUNNING or PAUSED.

### Adaptive stop (per area)

Triggered every time a reply is received and its `POST /api/analyze/reply` completes:

```
1. Identify the area of the replied-to message
2. Increment CampaignArea.replyCount for (campaignId, areaId)
3. If campaign.stopOnTargetReached AND replyCount >= effectiveTarget:
   a. Set CampaignArea.targetReached = true
   b. UPDATE Message SET status = 'CANCELLED'
      WHERE campaignId = X AND areaId = X AND status IN ('PENDING', 'QUEUED')
   c. Emit SSE event: { type: 'area_target_reached', areaId, areaName, replyCount }
4. Worker skips any job whose Message.status = 'CANCELLED' at step 1 of job logic
```

`CANCELLED` messages are distinct from `FAILED` — they are shown differently in the campaign detail UI (greyed out, no error badge).

### Enqueue preview + contact picker

The "Start Campaign" button opens a two-tab modal:

**Tab 1 — Preview**
Calls `POST /api/campaigns/:id/enqueue?preview=true`. Returns per-area counts without writing anything:

| Column | Meaning |
|---|---|
| Total | All contacts in area |
| Wrong Type | Wrong contactType |
| Not Validated | Need WA check |
| Ready | phoneValid + waChecked + correct type |
| Will Send | min(sendLimit, ready) |
| Target | targetRepliesPerArea |

**Tab 2 — Select Contacts**
Calls `GET /api/campaigns/:id/contacts`. Returns up to 100 eligible contacts per area.

Each contact has:
- `alreadyReplied: boolean` — true if they have a Reply in **any campaign** with the same `bulan` + `campaignType`. These rows are **disabled** (grey, checkbox locked unchecked) to prevent double-sending to contacts who already answered the same question.

UI behaviour:
- Contacts grouped by area with a per-area "Select all / Clear" toggle
- Search box filters client-side by store name (no pagination — all ≤ 100 shown in a scrollable container)
- Default selection: all non-disabled contacts pre-checked
- Live counter: `42 / 87 selected (12 already replied)`

When confirming, the selected `contactIds[]` are passed to `POST /api/campaigns/:id/enqueue`. If the user skips the tab and confirms from Preview, no `contactIds` are passed and the auto-select behaviour applies.

---

## Anti-Ban Strategy

### Browser Layer

| Measure | Implementation |
|---|---|
| Non-headless browser | `headless: false` — real visible Chromium windows |
| Stealth fingerprint removal | Custom `addInitScript` patches (webdriver, chrome runtime, plugins, languages, permissions) |
| Persistent browser profile | `launchPersistentContext` — same cookies/localStorage across sessions (per agent) |
| Real viewport + screen | `viewport: null` matches physical screen size |
| Real locale + timezone | `locale: 'id-ID'`, `timezoneId: 'Asia/Jakarta'` |

### Interaction Layer

| Measure | Implementation |
|---|---|
| Human typing speed | `TYPE_DELAY_MIN_MS`–`TYPE_DELAY_MAX_MS` ms per keystroke — configurable per agent |
| Pre/post-action pauses | Random pauses between each UI action |
| Click vs Enter | Always click the Send button — never programmatic Enter key |

### Timing Layer

| Measure | Implementation |
|---|---|
| Gaussian interval | Mean 35s, stddev 8s, floor 20s, ceiling 90s — never mechanical (per agent) |
| Working hours only | 08:00–17:00 WIB, Mon–Sat (enforced per agent) |
| Daily hard cap | `DAILY_SEND_CAP=150` per agent (overridable per agent) — stops that agent's queue slot when reached |
| Mid-session breaks | Every 30 messages per agent → random 3–8 min pause |

### Content Layer

| Measure | Implementation |
|---|---|
| Message variation | Claude subtly rephrases each message before send (Job 3) |
| No identical content | No two outgoing messages have the same byte content |

### Session Layer

| Measure | Implementation |
|---|---|
| Never log out | Browser profile persisted indefinitely (per agent) |
| Serialized per agent | One Playwright page per agent — no parallel sends within an agent |
| Consistent "device" | Same browser profile = same fingerprint every session (per agent) |
| Independent accounts | Each agent is a separate WhatsApp identity — one ban does not affect others |

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
- Cards: Total contacts, active campaigns, messages sent today (across all agents), reply rate today, daily cap remaining (per agent, shown as a mini-table)
- Recent campaigns table (name, status, progress bar, reply rate)
- Agent status overview — one badge per agent (online/QR/offline), clickable to navigate to `/agents`
- Live screenshot of the first ONLINE agent (refreshes every 5s)

### `/agents` — Agent Manager
- List of all registered agents with:
  - Name, department assignment (or "Pool"), status badge, active jobs, messages sent today
  - Live screenshot thumbnail (refreshes every 5s)
  - **Start** button (OFFLINE) / **Restart** button (STARTING — stuck after browser closed) / **Retry** button (ERROR) / **Stop** button (ONLINE, QR)
  - Edit button (name, phone, daily cap, break timing, typing speed, department)
  - Delete button (only if OFFLINE)
- **"Add Agent"** button → modal: name + phone number (required) + daily send cap + break settings + typing speed + optional department — all timing fields pre-filled with env defaults, editable per agent → creates `Agent` in DB + profile path auto-set to `{BROWSER_PROFILE_PATH}/{agentId}/`
- **Edit button** on each agent card → modal with the same fields for updating name, phone, cap, timing, and department
- Per-agent QR code prompt when WA Web needs re-authentication (screenshot shows QR — user scans)

### `/import` — Import Contacts
- Folder tree scanned from DATA_FOLDER: **Type (STIK / KARDUS) → Department → Area**
- Each area node shows its `contactType` badge (e.g. `[STIK]`)
- Per-area: import button → shows parsed headers
- Claude suggests column mapping → user reviews + confirms
- `contactType` is passed automatically in the import body (read from the folder path — no manual selection needed)
- Import progress: valid contacts / invalid phones / skipped duplicates

### `/contacts` — Contact Browser
- Filter by status: **Semua / Belum dicek / Terdaftar / Tidak valid**
- **"Validasi WA"** button — opens a multi-area selection modal:
  - Shows **all areas** grouped by type (STIK / KARDUS)
  - **Never-validated areas** (`validated = 0`): checked by default, showing unchecked count
  - **Areas with any validated phones** (`validated > 0`, partial or full): **unchecked by default**, muted style + green checkmark. Shows "N dicek" for fully validated, or "N dicek · M belum" for partially validated. Below that, shows registered/invalid breakdown (e.g. "85 terdaftar / 16 tidak valid"). Can be selected to validate remaining or re-check all.
  - "Pilih Semua / Hapus Semua" toggle per group (includes validated areas)
  - Search box to filter areas by name
  - "Limit per area" input (default: 60) with "Tanpa limit" option
  - Summary: total contacts to be queued across selected areas (includes re-check areas)
  - On confirm: splits selected areas into `areaIds` (unchecked > 0) and `recheckAreaIds` (fully validated)
- **"Cek Ulang Semua"** button — re-queues all contacts regardless of current status (bypasses modal)
- Columns: No, Store Name, Department, Area, Phone (raw), Phone (normalized), **Status WA**, Exchange
- Status WA badge: Gray "Belum dicek" / Green "Terdaftar" / Red "Tidak valid"

### Global — WA Validation Banner
- Appears at the **top of every page** while phone-check jobs are in flight
- Shows spinner + counts: `{active} sedang dicek, {waiting} antrian tersisa`
- Polls `GET /api/contacts/validate-wa/status` every 4 seconds
- Disappears automatically when queue is empty

### `/campaigns` — Campaign List
- Status badges: DRAFT / RUNNING / PAUSED / COMPLETED / CANCELLED
- Status filter dropdown (All + each campaign status) backed by `GET /api/campaigns?status=...`
- Stats cards for currently shown rows: `Shown`, `Running`, `Paused`, `In Queue`, `Failed`, `Replies`
- Progress bar: `sent/total`
- Queue/failed visibility per row via `Queue / Failed` column (`Q {pending+queued} / F {failed}`)
- **Already Replied** column — shows `alreadyRepliedCount` (unique contacts who replied for that `bulan` + `campaignType`, capped at `targetRepliesPerArea` per area — excess replies beyond target are ignored) alongside the bulan and type label (e.g. "42 Desember · STIK"). Helps the user see useful reply coverage across all campaigns for the same month + type.
- Actions: View, Cancel

### `/campaigns/new` — Create Campaign
1. Name + `{{bulan}}` field
2. **Campaign type** — radio button: `STIK` / `KARDUS`. Selecting a type filters the area tree in step 3 to only show areas of that type.
3. Message template editor
4. Select target areas — **Department → Area tree** filtered to the selected campaign type (collapsible, per-area checkboxes with dept-level select-all)
5. Selected area count shown live
6. **Send Configuration** section (pre-filled from `AppConfig` global defaults, user can override):
   - "Target replies per area" — number input
   - "Expected reply rate" — percentage input
   - "Messages to send per area" — computed read-only: `ceil(target / rate)`
   - These values are saved on the Campaign record (`targetRepliesPerArea`, `expectedReplyRate`)
7. Submit → status = DRAFT; "Start Campaign" button on detail page

Campaign targets specific **areas** of a single type (not whole departments). At enqueue time, only contacts with `contactType = campaign.campaignType AND phoneValid = true AND waChecked = true` are queued. If a contact's department has an assigned agent, `MessageJob.agentId` is set at enqueue time.

### `/campaigns/:id` — Campaign Detail
- Progress: sent / delivered / read / failed (campaign totals)
- Live SSE feed updating counts in real-time
- Pause / Resume / Cancel buttons
- **"Start Campaign" button (DRAFT only)**:
  - First shows the **enqueue preview table** (calls `POST /api/campaigns/:id/enqueue?preview=true`):

    | Area | Valid contacts | Will send | Target replies | Warning |
    |---|---|---|---|---|
    | Aceh Barat | 87 | 40 | 20 | — |
    | Aceh Utara | 12 | 12 | 20 | Only 12 contacts available |

  - User confirms → actual enqueue (`POST /api/campaigns/:id/enqueue`)
- **Per-area progress table** (live, updates via SSE):

  | Area | Sent | Replies | Target | Status |
  |---|---|---|---|---|
  | Aceh Barat | 18 | 7 | 20 | Running |
  | Aceh Utara | 12 | 12 | 20 | **Target reached** (green badge) |

  Status badges: Running / Target Reached / Completed (all sent) / Paused
- Message table (paginated, filterable by status — includes CANCELLED) — includes **Agent** column
- **FAILED messages** show a clickable "FAILED ℹ" badge — clicking opens `FailReasonModal`
- **CANCELLED messages** shown greyed out with a "CANCELLED" badge (no error)
- Reply summary (confirmed % / denied % / unclear %)

### `/responses` — Reply Inbox
- Table: Campaign | Store Name | Phone | Area | Dept | Message Sent | Reply | Summary | Jawaban | Category | Time | Screenshot
- Inline manual correction controls per row:
  - `Jawaban` selector: `Ya` | `Tidak` | `Tidak Jelas`
  - `Category` selector: `confirmed|denied|question|unclear|other`
  - `Save` button updates selected row via `PATCH /api/replies/:id`
- Manual correction endpoint:
  - `PATCH /api/replies/:id`
  - Body: `{ category?: ReplyCategory|null, jawaban?: 1|0|null }`
  - Use case: fix Claude misclassification (e.g. move `unclear` to `confirmed`)
- Export to XLSX button (`GET /api/export/responses`)
- "Write to Output Folder" button (`POST /api/export/write`)
- "Regenerate CSV Reports" button (`POST /api/export/report`)
- **Download Report (with screenshots)** bar:
  - Campaign picker — `<select>` populated from `GET /api/campaigns`, each option labelled `{Name} — {Bulan} — {Type}` (e.g. "Campaign Jan — Januari — STIK")
  - "Download XLSX" button — disabled until a campaign is selected
  - On click: fetches `GET /api/export/report-xlsx?campaignId=xxx` as a blob, triggers browser download with filename `{Type}_{Bulan}_{YYYY-MM-DD}.xlsx`
  - Button shows a spinner + "Generating…" label while the request is in-flight

### `/settings` — Settings
- **Campaign Defaults** section (editable, saved to `AppConfig` via `PATCH /api/config`):
  - "Target replies per area" — number input (default 20)
  - "Expected reply rate" — percentage input (default 50%)
  - "Messages to send per area" — computed read-only: `ceil(target / rate)`, e.g. "40 messages"
  - Save button
- Config display (working hours, rate limits, daily cap) — read-only from env
- Link to `/agents` for browser/agent management (browser controls moved to `/agents`)
- **Maintenance** section:
  - "Unexpire all messages" button — moves all `EXPIRED` messages back to `SENT` for re-polling
- **Manual Reply Poll** section:
  - Input accepts one phone per line or comma-separated list (max 100)
  - Triggers `POST /api/replies/poll-manual` with `{ phones: string[] }`
  - API behavior per phone:
    1. Prefer latest unreplied message (`SENT|DELIVERED|READ|EXPIRED|FAILED`, `reply=null`, `agentId!=null`)
    2. If none, fallback to latest message (`SENT|DELIVERED|READ|EXPIRED|FAILED`, `agentId!=null`)
  - Selected phones are grouped by `agentId` and published to Redis channel `reply:poll-manual`
  - Worker behavior for manual poll:
    - Uses best-effort scan mode (stale-anchor guard disabled for this flow)
    - Allows recovering replies for messages that drifted to `FAILED`/`EXPIRED`
    - For `mode=fallback_latest`, if no unreplied message exists, refreshes the latest existing reply for that phone (updates text + Claude fields) without incrementing counters
  - Response shape:
    - `queued[]`: `{ phone, agentId, mode }`, where `mode` is `unreplied` or `fallback_latest`
    - `skipped[]`: invalid numbers or phones with no sent message tied to an agent

---

## Output Files

### XLSX — full response log

Written to `OUTPUT_FOLDER/responses_YYYY-MM-DD.xlsx` (or downloaded via `GET /api/export/responses`):

| No | Department | Area | Nama Toko | No HP | Pesan Dikirim | Status | Waktu Kirim | Balasan | Kategori | Waktu Balas |
|---|---|---|---|---|---|---|---|---|---|---|

> `Sentimen` and `Ringkasan` removed — not needed. `Department` and `Area` added so each row is self-identifying without needing to cross-reference the filename.

### XLSX — per-area report with embedded screenshots (on-demand download)

Generated by `GET /api/export/report-xlsx?campaignId=xxx` using **ExcelJS** (not SheetJS — SheetJS free tier does not support image embedding).

One workbook per campaign download. The campaign already encodes `bulan` + `campaignType`, so each download is naturally scoped to one month + one type.

Includes **all contacts who were sent a message** in this campaign — not just those who replied. Rows without a reply show "Pending" in the Jawaban column and no screenshot.

**Workbook structure:**
- One sheet per area in the campaign, named `{Area Name}` (truncated to 31 chars)
- Final sheet named `Info` — campaign name, type, bulan, date generated, total rows

**Each area sheet columns:**

| Col | Header | Notes |
|---|---|---|
| A | No | Row number |
| B | Nama Toko | Store name |
| C | Nomor HP Toko | Normalized phone |
| D | Department | Department name |
| E | Area | Market/area name |
| F | Agent Phone | WhatsApp number of the agent that sent the message |
| G | Jawaban | "Ya ✓" (green), "Tidak ✗" (red), or "Pending" (grey italic) |
| H | Screenshot | Embedded `.jpg` image — blank if no reply yet |

- Row height auto-set to fit the image (~140pt) for rows that have a screenshot
- Alternate row shading for readability
- If a screenshot file is missing from disk, column E shows the path as plain text instead
- Triggered on-demand only (not auto-generated after each reply like the CSV)

**Dependency:** `exceljs` must be added to `@aice/api`

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

pnpm db:migrate       # run Prisma migrations (safe — additive only)
pnpm db:generate      # regenerate Prisma client
pnpm db:studio        # open Prisma Studio
pnpm db:fresh         # ⚠️  drop + recreate DB — DESTROYS ALL DATA — never run in production

pnpm redis:flush      # FLUSHALL — clear all Redis keys + BullMQ queues
```

### Database migration rules

**NEVER** use `prisma db push --force-reset` or `pnpm db:fresh` on any environment that has real data. These commands drop the entire database with no recovery path.

For schema changes on a live database, always use additive migrations:

```bash
# Add new columns / tables — safe, does not touch existing rows
npx prisma db push --schema=prisma/schema.prisma --accept-data-loss

# Or generate a named migration file first, review it, then apply
npx prisma migrate dev --name describe_the_change
```

`--accept-data-loss` only silences warnings about constraint changes — it does **not** drop data unless `--force-reset` is also passed.

---

## Project File Structure

```
whatsapp-automation/
├── packages/
│   ├── shared/
│   │   └── src/index.ts              # All shared TypeScript types (incl. AgentStatus, AgentInfo)
│   ├── api/
│   │   ├── prisma/schema.prisma      # MySQL schema (single source of truth)
│   │   └── src/
│   │       ├── index.ts              # Express app + startup validation
│   │       ├── lib/
│   │       │   ├── db.ts             # Prisma client
│   │       │   ├── excel.ts          # SheetJS folder scanner (type→dept→area) + xlsx parser
│   │       │   ├── phone.ts          # Indonesian phone normalizer + validator
│   │       │   ├── claude.ts         # Anthropic SDK (Job 1: headers, Job 2: reply)
│   │       │   ├── queue.ts          # bullmq queue producers (messages + phone-check) + Redis
│   │       │   ├── exporter.ts       # Output xlsx writer (SheetJS — full response log)
│   │       │   ├── report.ts         # Per-area CSV report generator (Jawaban 1/0)
│   │       │   ├── report-xlsx.ts    # Per-area XLSX report with embedded screenshots (ExcelJS)
│   │       │   └── validate.ts       # Startup env + connection checks
│   │       └── routes/
│   │           ├── agents.ts         # /api/agents/* (NEW)
│   │           ├── browser.ts        # /api/browser/* (aggregate status + events)
│   │           ├── config.ts         # /api/config (NEW — AppConfig CRUD)
│   │           ├── files.ts          # /api/files/*
│   │           ├── contacts.ts       # /api/contacts/* (incl. validate-wa)
│   │           ├── campaigns.ts      # /api/campaigns/*
│   │           ├── analyze.ts        # /api/analyze/*
│   │           └── export.ts         # /api/export/*
│   ├── worker/
│   │   └── src/
│   │       ├── index.ts              # BullMQ workers (messages + phone-check) + startup
│   │       └── lib/
│   │           ├── agent-manager.ts  # NEW: owns N BrowserAgent instances, getLeastBusyAgent()
│   │           ├── browser-agent.ts  # RENAMED from browser.ts — scoped to one profile/session
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
│                                     # NewCampaign, CampaignDetail, Responses, Settings,
│                                     # Agents (NEW)
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
| WhatsApp account ban | Visible browser, stealth init script, Gaussian timing, daily cap per agent, working hours, message variation, mid-session breaks |
| One agent banned | Other agents continue operating; banned agent is marked OFFLINE; its pending jobs are re-assigned to pool |
| Ban + reconnect: replies missed during downtime | Reply poll runs immediately when browser status transitions to `'connected'` (reconnect watcher checks every 5s). WA Web loads full message history, so replies sent during the ban are captured on the first poll after QR scan. |
| Ban + reconnect: messages that failed to send | Messages mid-queue during ban hit the 10-min timeout and become `FAILED`. They are NOT automatically re-sent after reconnect — user must manually re-enqueue them (future: "Retry failed" button on campaign detail). |
| Concurrent reply polls | `_isPolling` flag in `startReplyPolling` prevents two polls running simultaneously (e.g. if a poll takes longer than `REPLY_POLL_INTERVAL`). Without this, duplicate `Reply` records would be created. |
| WhatsApp Web UI changes | Playwright selectors abstracted in `browser-agent.ts` for easy updates |
| Browser crashes or window closed externally | `context.on('close')` fires → `BrowserAgent` clears internal refs + sets status to `disconnected` → `AgentManager` 15s polling loop publishes `OFFLINE` to Redis/DB → Start button reappears automatically. `close()` always clears refs before calling `ctx.close()` so a Restart works even if the context is already dead. |
| Agent profile dir missing | Worker creates `{BROWSER_PROFILE_PATH}/{agentId}/` on first launch |
| Inconsistent Excel headers | Claude-assisted mapping with user confirmation step |
| Excel strips leading zero from phone | Normalizer detects `8xxx` prefix and prepends `62` |
| Excel scientific notation for phone | Normalizer detects and parses `8.12E+10` before stripping |
| Messages sent to unregistered numbers | `checkPhoneRegistered` validates before campaign; send failure also auto-invalidates contact |
| Phone check misses unregistered numbers | Promise.race on compose box vs popup — reliable for both valid and invalid numbers |
| Send + phone-check collision within one agent | `_withBrowserLock` mutex per BrowserAgent serialises all page interactions for that agent |
| No agents online when job is picked up | Worker polls `getLeastBusyAgent()` every 10s up to 10 min before failing the job |
| Messages sent outside hours | Worker reschedules job via `job.moveToDelayed(msUntilNextOpen())` — no sleeping inside the job; BullMQ re-delivers at next working-hours open |
| Daily cap exceeded | `DailySendLog` checked per-agent at selection time; capped agents are skipped in favour of agents still under cap; if all agents are capped the job is rescheduled via `moveToDelayed` |
| Invalid phone numbers | Format-validated at import; WA-validated before campaign enqueue |
| Redis unavailable | Startup validation exits with error before accepting traffic |
| MySQL unavailable | Startup validation exits with error before accepting traffic |
| Missing env vars | Startup validation exits with clear per-variable error list |
| Session expired (QR needed) | Agent screenshot in `/agents` page shows QR; user scans to re-auth per agent |
| Area has fewer contacts than sendLimit | All available contacts enqueued; UI shows warning in preview table |
| Reply target never reached | Area shows "Short by N" badge once batch is fully sent. User manually triggers top-up when ready (e.g. after waiting a day for replies). |
| Stale BullMQ jobs after DB reset | `pnpm redis:flush` clears all queues |

---

## Notes

- Each Playwright browser runs as a **visible Chromium window** for its agent inside `@aice/worker`. Windows must not be minimized while campaigns are active.
- All timestamps are stored as UTC in MySQL. Timezone conversion to `Asia/Jakarta` happens in the scheduler and UI display layer.
- In production, manage the three processes with `pm2`: API server, worker, and optionally a static web build served by nginx.
- `DAILY_SEND_CAP` is the **global default** daily cap. Each agent can override it with `agent.dailySendCap`. With 3 agents at 150/day each, total throughput = up to 450 messages/day.
- `sendLimit` (send targeting) and `DAILY_SEND_CAP` are independent caps — whichever is hit first stops sends for that scope (area vs. agent-day). A campaign with `sendLimit=40` across 10 areas = 400 total messages, spread across days if the daily cap is lower.
- This project uses the WhatsApp Web interface via browser automation. It is against WhatsApp's Terms of Service. Use responsibly. For large-scale or commercial deployments, migrate to the official Meta WhatsApp Business API.
