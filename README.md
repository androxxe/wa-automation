# AICE WhatsApp Automation

> **Fully vibecoded.** This entire project — architecture, code, and configuration — was built through AI-assisted development using [OpenCode](https://opencode.ai). No line was written by hand.

A full-stack web application for managing bulk WhatsApp messaging campaigns targeting AICE ice cream distribution partners. Reads contacts from `.xlsx` files, sends personalized messages via a real visible Chromium browser (Playwright), captures replies, analyzes them with Claude AI, and exports results to Excel.

---

## Tech Stack

| Layer | Tool |
|---|---|
| API server | Express.js + TypeScript |
| Frontend | React + Vite + Tailwind CSS + shadcn/ui |
| Browser automation | Playwright + playwright-extra (stealth) |
| Queue | BullMQ + Redis |
| Database | Prisma + MySQL |
| AI | Anthropic Claude (header mapping, reply analysis, message variation) |
| Excel | SheetJS (xlsx) |
| Monorepo | pnpm workspaces |

---

## Project Structure

```
whatsapp-automation/
├── packages/
│   ├── shared/     # TypeScript types shared across packages
│   ├── api/        # Express.js REST API + all server-side lib
│   ├── worker/     # BullMQ worker — owns the Playwright browser
│   └── web/        # React + Vite frontend
├── .env            # Single env file for all packages
├── .env.example    # Copy this to .env to get started
└── spec/SPEC.md    # Full project specification
```

---

## Prerequisites

- Node.js 20+
- pnpm 10+
- MySQL 8+ (running locally or remote)
- Redis (running locally or remote)

---

## Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd whatsapp-automation
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `DATABASE_URL` | MySQL connection string |
| `REDIS_URL` | Redis connection string |
| `DATA_FOLDER` | Absolute path to folder containing `Department 1..9` xlsx files |
| `OUTPUT_FOLDER` | Absolute path where response xlsx files will be written |

### 3. Create the database

```bash
mysql -u root -e "CREATE DATABASE IF NOT EXISTS wa_automation;"
```

### 4. Run migrations

```bash
pnpm --filter @aice/api db:migrate -- init
```

---

## Startup Validation

Both the API and worker validate their environment before starting. If anything is wrong you get a clear error and the process exits immediately — no silent failures.

```
  Startup checks

  environment variables
  ✓  ANTHROPIC_API_KEY (present)
  ✓  ANTHROPIC_API_KEY (format)
  ✓  DATABASE_URL (present)
  ✓  DATABASE_URL (format)
  ✓  REDIS_URL
  ✓  DATA_FOLDER
  ✓  DATA_FOLDER (exists)
  ✓  OUTPUT_FOLDER

  connections
  ✓  MySQL database
  ✓  Redis

  All checks passed
```

---

## Running in Development

Three processes must run simultaneously — open three terminals:

```bash
# Terminal 1 — API server (port 3001)
pnpm dev:api

# Terminal 2 — Worker (Playwright browser + queue consumer)
pnpm dev:worker

# Terminal 3 — Web frontend (port 5173)
pnpm dev:web
```

Open `http://localhost:5173`.

---

## Usage

### Step 1 — Connect WhatsApp

1. Go to **Settings**
2. Click **Open Browser** — a visible Chromium window opens WhatsApp Web
3. On your phone: WhatsApp → Linked Devices → Link a Device → scan the QR code
4. Status turns **connected** — the session is saved to `browser-profile/` so you only scan once

### Step 2 — Import contacts

1. Go to **Import**
2. Select a department/area xlsx file from the tree
3. Click **Suggest Column Mapping with Claude** — Claude reads the headers and maps them to internal fields
4. Review the mapping and click **Confirm and Import**
5. Repeat for each area you want to target

The importer handles bilingual (Indonesian/Chinese) headers and normalizes all Indonesian phone numbers to E.164 format (`+62...`). All real-world xlsx formats are handled automatically:

| Input | Result |
|---|---|
| `08121234567` | `+628121234567` |
| `8121234567` | `+628121234567` — Excel stripped leading zero |
| `8.21167464117E+11` | `+62821167464117` — Excel scientific notation |
| `+628121234567` | `+628121234567` — unchanged |

Invalid numbers are flagged and excluded from campaigns.

### Step 3 — Create a campaign

1. Go to **Campaigns → New Campaign**
2. Fill in name, bulan (month), and message template
3. Select target areas from the **Department → Area tree** — expand a department and check individual areas, or check the department row to select all its areas
4. Click **Create Campaign** — saved as `DRAFT`

**Default template:**
```
Halo bapak/ibu mitra aice {{area}} toko {{nama_toko}}, saya dari tim inspeksi aice pusat Jakarta ingin melakukan konfirmasi. Apakah benar bahwa pada bulan {{bulan}} toko bapak/ibu telah melakukan penukaran Stick ke distributor?
```

Available variables: `{{nama_toko}}` `{{bulan}}` `{{department}}` `{{area}}`

### Step 4 — Run the campaign

1. Open the campaign detail page
2. Click **Start Campaign**
3. The worker processes jobs one by one:
   - Checks working hours (08:00–17:00 WIB, Mon–Sat)
   - Waits a Gaussian-random interval (~35s avg, ±8s)
   - Asks Claude to slightly rephrase the message (no two messages are byte-identical)
   - Types and sends via the visible Chromium window with human-like mouse and typing simulation
   - Takes a 3–8 min break every 30 messages
4. Live progress (sent / delivered / read) updates in real time via SSE

Use **Pause**, **Resume**, or **Cancel** at any time.

### Step 5 — Replies and export

- Replies are detected automatically every 60s by the worker (DOM polling on WhatsApp Web)
- **Only replies from contacts we sent to** are processed — random messages on your personal WhatsApp are ignored
- A screenshot of the chat is saved to `OUTPUT_FOLDER/screenshots/{phone}_{timestamp}.jpg`
- Each reply is analyzed by Claude: category (`confirmed` / `denied` / `question` / `unclear`) and sentiment
- A binary **Jawaban** (`1` = Ya/Yes, `0` = Tidak/Nggak) is determined from keyword matching + Claude category
- A CSV report is auto-generated to `OUTPUT_FOLDER/{Department}/{Area}.csv` after every analyzed reply
- Go to **Responses** to view and filter all replies
- Click **Export XLSX** to download the full response log
- Click **Regenerate CSV Reports** to manually rebuild all area CSVs

**CSV format:**
```csv
Nama Toko,Nomor HP Toko,Jawaban,Screenshot
Toko ABC,+628121234567,1,/path/to/output/screenshots/628121234567_2026-03-14.jpg
Toko XYZ,+628121234568,0,
```
The `Screenshot` column is a file path to a `.jpg` — open it in any image viewer. Images can't be embedded in CSV files.

---

## Anti-Ban Measures

| Layer | Measure |
|---|---|
| Browser | Visible Chromium window, stealth fingerprint plugin, persistent profile |
| Mouse | ghost-cursor Bezier-curve trajectories |
| Typing | 60–180ms per keystroke with random jitter |
| Timing | Gaussian-distributed intervals (not fixed), working hours only |
| Daily cap | 150 messages/day hard limit |
| Breaks | 3–8 min break every 30 messages |
| Content | Claude rephrases each message — no two are identical |

---

## Database Scripts

```bash
# Apply schema changes (creates a new migration)
pnpm --filter @aice/api db:migrate -- <migration-name>

# Apply existing migrations (CI/production)
pnpm --filter @aice/api db:migrate:apply

# Push schema without migration history (quick dev reset)
pnpm db:push

# Open Prisma Studio (GUI for the database)
pnpm db:studio
```

---

## Environment Variables Reference

See [`.env.example`](.env.example) for a fully annotated reference of all available variables.

---

## Disclaimer

This project automates the WhatsApp Web interface via browser automation, which is against WhatsApp's Terms of Service. Use responsibly and at your own risk. For large-scale or commercial deployments, migrate to the official [Meta WhatsApp Business API](https://developers.facebook.com/docs/whatsapp).
