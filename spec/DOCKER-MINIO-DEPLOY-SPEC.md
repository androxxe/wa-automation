# Docker + MinIO + PostgreSQL Deployment Spec

## Overview

Migrates the WhatsApp automation monorepo from a macOS-local dev setup to a
Docker-based Ubuntu deployment with:

- **PostgreSQL** (replacing MySQL)
- **MinIO** for object storage (reply screenshots, CSV reports, XLSX exports)
- **Docker Compose** orchestrating api, worker, web (Nginx), and Redis
- **QR code scannable from the Agents page** (screenshot fix)
- **VNC access** to the worker's virtual display (Xvfb + x11vnc)

---

## 1. PostgreSQL Migration

### Problem

The codebase currently targets MySQL (`provider = "mysql"`, `mysql2` driver,
`DATABASE_URL` validation rejects non-`mysql://` strings). The production
deployment uses a hosted PostgreSQL instance.

### Files changed

| File | Change |
|---|---|
| `packages/api/prisma/schema.prisma:6` | `provider = "mysql"` -> `provider = "postgresql"` |
| `packages/api/package.json` | Remove `mysql2` dependency |
| `packages/api/src/lib/validate.ts:34` | Accept `postgresql://` and `postgres://` in `checkDatabaseUrl()` |
| `.env.example` | Update `DATABASE_URL` format to `postgresql://` |

### Schema compatibility

All Prisma annotations used in the schema are PostgreSQL-compatible:

- `@db.VarChar(500)` -- supported
- `@db.Text` -- supported
- `Json` type -- supported (native `jsonb`)
- `cuid()` -- client-side generation, no DB dependency
- `autoincrement()` -- maps to `SERIAL` in PostgreSQL

No schema changes needed beyond the provider swap.

### Migration steps

```bash
# Fresh PostgreSQL database (first deploy)
docker compose exec api npx prisma migrate deploy \
  --schema=packages/api/prisma/schema.prisma

# Or push schema directly (dev/testing)
docker compose exec api npx prisma db push \
  --schema=packages/api/prisma/schema.prisma
```

---

## 2. QR Screenshot Fix

### Problem

Screenshots are only taken when `agent.status === 'connected'` (ONLINE) in
`agent-manager.ts:191`. During QR state, no screenshot is captured, so the
Agents page shows "No preview" even though the browser has the QR code visible.

Additionally, the screenshot thumbnail on the Agents page (`w-40 h-28` = 160x112px)
is too small to scan a QR code with a phone.

### Files changed

| File | Line(s) | Change |
|---|---|---|
| `packages/worker/src/lib/agent-manager.ts` | 191 | Extend condition: `agent.status === 'connected' \|\| agent.status === 'qr'` |
| `packages/web/src/pages/Agents.tsx` | 407 | Expand screenshot container to `w-72 h-72` + `object-contain` when status is `QR` |

### Behavior after fix

| Agent status | Screenshot? | Thumbnail size |
|---|---|---|
| `connected` (ONLINE) | Yes, every 15s | 160x112px (`w-40 h-28`) |
| `qr` (QR) | Yes, every 15s | 288x288px (`w-72 h-72`) |
| `loading` (STARTING) | No | N/A |
| `disconnected` (OFFLINE) | No | N/A |

During QR state, `#main` (chat panel) does not exist, so the screenshot method
falls back to a full-page capture -- which includes the QR canvas. The frontend
displays it at 288x288px with `object-contain` so the QR is large enough to scan.

---

## 3. MinIO Integration

### What moves to MinIO

| Data | Current storage | New storage (MinIO key) |
|---|---|---|
| Reply screenshots | `$OUTPUT_FOLDER/screenshots/{phone}_{ts}.jpg` | `screenshots/{phone}_{ts}.jpg` |
| CSV area reports | `$OUTPUT_FOLDER/{Type}/{Dept}/{Area}_{bulan}_{date}.csv` | `reports/csv/{Type}/{Dept}/{Area}_{bulan}_{date}.csv` |
| Daily XLSX writes | `$OUTPUT_FOLDER/responses_{date}.xlsx` | `reports/xlsx/responses_{date}.xlsx` |

### What stays unchanged

- **Live preview screenshots** (QR/ONLINE) -- stored as base64 in Redis with 30s
  TTL, served inline via the API. Ephemeral by nature, no file storage needed.
- **On-demand XLSX exports** (`GET /api/export/responses`,
  `GET /api/export/report-xlsx`) -- generated per-request, returned as a buffer
  in the HTTP response. No persistent storage needed.

### New environment variables

```bash
MINIO_ENDPOINT=your-minio-host   # hostname only, no protocol
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=
MINIO_SECRET_KEY=
MINIO_BUCKET=whatsapp-automation
```

`OUTPUT_FOLDER` is removed from both packages (no longer needed).

### New packages

| Package | Added to |
|---|---|
| `minio` | `packages/worker/package.json` |
| `minio` | `packages/api/package.json` |

### New files

| File | Purpose |
|---|---|
| `packages/worker/src/lib/minio.ts` | MinIO client singleton, `ensureBucket()`, `uploadBuffer()` helpers |
| `packages/api/src/lib/minio.ts` | MinIO client singleton, `ensureBucket()`, `presignedUrl()`, `getBuffer()` helpers |

### Files changed

| File | Change |
|---|---|
| `packages/worker/src/lib/browser-agent.ts` | `_saveReplyScreenshot()`: remove all `fs` disk writes, upload JPEG buffer to MinIO via `putObject()`, return object key (stored in DB `screenshotPath`) |
| `packages/api/src/routes/replies.ts` | `GET /api/replies/screenshot?p=`: remove `fs.existsSync` + `res.sendFile()`, generate MinIO presigned URL (1hr expiry), `res.redirect(url)` |
| `packages/api/src/lib/report.ts` | `generateAreaReport()`: remove `fs.mkdirSync` + `fs.writeFileSync`, upload CSV buffer to MinIO, return object key |
| `packages/api/src/lib/report-xlsx.ts` | `buildCampaignReportXlsx()`: replace `fs.readFileSync(absPath)` with `minio.getObject()` + stream-to-buffer for embedding images |
| `packages/api/src/lib/exporter.ts` | `writeOutputFiles()`: replace `fs.writeFileSync` with MinIO `putObject()` |
| `packages/api/src/lib/validate.ts` | Remove `OUTPUT_FOLDER` env check, add `checkMinio()` async check (bucket exists) |

### Serving strategy: presigned URLs

When the frontend requests a screenshot (`GET /api/replies/screenshot?p=screenshots/...`):

1. API receives the object key from the `?p` query param
2. Validates it doesn't contain path traversal
3. Calls `minio.presignedGetObject(bucket, key, 3600)` -- 1 hour expiry
4. Returns `302 Redirect` to the presigned URL
5. Browser fetches directly from MinIO

Benefits: no proxying through the API, MinIO handles bandwidth.

### DB schema impact

The `Reply.screenshotPath` field (`String? @db.VarChar(500)`) stays unchanged.
It stores an object key (e.g. `screenshots/628xxx_2026-01-01.jpg`) instead of a
local file path. No migration needed.

---

## 4. Docker Deployment

### Architecture

```
                     :80
                  +--------+
    Browser ----->|  web   |
                  | Nginx  |
                  +---+----+
                      |
              /api/*  |  static files served directly
                      v
                  +--------+       +----------+
                  |  api   |       |  worker  |
                  | Express|       | Playwrigh|
                  | :3001  |       | Xvfb+VNC |
                  +---+----+       +----+-----+
                      |                 |
              +-------+---------+-------+
              |                 |
          +---v---+         +--v---+
          | redis |         | (ext)|
          | :6379 |         | MySQL|  <-- actually PostgreSQL
          +-------+         | MinIO|
                            +------+
```

### Services

| Service | Base image | Exposed port | Notes |
|---|---|---|---|
| `redis` | `redis:7-alpine` | (internal only) | AOF persistence via named volume |
| `api` | `node:22-slim` | 3001 (internal) | Express server, Prisma client |
| `worker` | `mcr.microsoft.com/playwright:v1.49.0-noble` | 5900 (VNC) | Xvfb + x11vnc + Chromium |
| `web` | `nginx:alpine` (built from `node:22-slim`) | 80 | Static React build + API proxy |

### New files

| File | Purpose |
|---|---|
| `docker/Dockerfile.api` | Build shared + api packages, run Express |
| `docker/Dockerfile.worker` | Build shared + worker packages, install Xvfb + x11vnc, run entrypoint |
| `docker/Dockerfile.web` | Multi-stage: Vite build in Node -> copy dist to Nginx |
| `docker/nginx.conf` | Static files + `/api/*` proxy to `http://api:3001` + SSE headers |
| `docker/worker-entrypoint.sh` | Start Xvfb -> x11vnc -> node worker |
| `docker-compose.yml` | Orchestrate all services |
| `.dockerignore` | Exclude node_modules, .git, .env files, data dirs |

### Dockerfile build order (critical)

Both `Dockerfile.api` and `Dockerfile.worker` follow this order:

**Builder stage:**
1. `pnpm install --frozen-lockfile` -- installs deps + Prisma postinstall hooks
2. Copy source files
3. **`prisma generate`** -- generates `@prisma/client` types (MUST run before tsc)
4. `tsc` -- compiles TypeScript (needs Prisma types)

**Production stage:**
1. `pnpm install --frozen-lockfile --prod` -- installs prod deps with pnpm symlink structure
2. Copy Prisma schema + **`prisma generate`** again in production stage
3. Copy compiled JS (`dist/`) from builder

Prisma generate runs in BOTH stages because pnpm uses a symlinked `.pnpm` store
structure. Copying the generated client from the builder's `.pnpm` directory
doesn't work because the symlinks won't match. Running `prisma generate` in the
production stage after `pnpm install --prod` ensures the client is generated
within the correct symlink tree.

The `node:22-slim` base image requires `openssl` for the Prisma engine binary
(installed via `apt-get`). The Playwright image already has it.

### Worker container detail

The worker container is the most complex because Chromium requires a display.

**Base image:** `mcr.microsoft.com/playwright:v1.49.0-noble`
- Pre-installed: all Chromium Linux dependencies (libatk, libgdk, libnss3, fonts, etc.)
- Pre-installed: Node.js 22
- Saves ~500MB+ of apt dependencies vs building from `node:22-slim`

**Additional packages:** `xvfb`, `x11vnc`

**Entrypoint sequence (`docker/worker-entrypoint.sh`):**
```bash
#!/bin/bash
set -e
# 1. Start virtual framebuffer
Xvfb :99 -screen 0 1920x1080x24 -ac &
sleep 1
# 2. Start VNC server (no password for internal use)
x11vnc -display :99 -forever -nopw -rfbport 5900 -shared -bg
# 3. Export display for Playwright
export DISPLAY=:99
# 4. Run the worker
exec node /app/packages/worker/dist/index.js
```

**Docker Compose overrides:**
- `shm_size: 2gb` (Chromium requires large shared memory)
- Volume: `browser_profiles:/app/browser-profiles` (persistent QR sessions)
- VNC port: `5900:5900`

### Nginx configuration (`docker/nginx.conf`)

```nginx
server {
    listen 80;

    # Static React build
    root /usr/share/nginx/html;
    index index.html;

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API proxy
    location /api/ {
        proxy_pass http://api:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE support
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header Connection '';
        chunked_transfer_encoding off;
    }
}
```

### Volumes

| Volume | Mounted at | Service | Purpose |
|---|---|---|---|
| `redis_data` | `/data` | redis | Redis AOF + RDB persistence |
| `browser_profiles` | `/app/browser-profiles` | worker | Playwright profiles (QR scan persists across restarts) |
| `./data` (bind mount) | `/app/data` | api | `DATA_FOLDER` for contact CSV imports |

### Docker Compose environment overrides

| Service | Variable | Value |
|---|---|---|
| api | `REDIS_URL` | `redis://redis:6379` |
| api | `CORS_ORIGIN` | `*` (or set to your domain) |
| worker | `REDIS_URL` | `redis://redis:6379` |
| worker | `BROWSER_PROFILE_PATH` | `/app/browser-profiles` |
| worker | `BROWSER_HEADLESS` | `false` |
| worker | `DISPLAY` | `:99` (set in entrypoint) |

### Web build strategy

`VITE_API_URL` is set to empty string at build time. `apiFetch()` in the
frontend uses `import.meta.env.VITE_API_URL ?? ''` which falls back to relative
URLs (e.g. `/api/agents`). Nginx proxies all `/api/*` requests to
`http://api:3001`. No CORS issues, no hardcoded URLs.

---

## 5. Docker Compose: Environment Configuration

The `docker-compose.yml` uses the `ENV_FILE` variable to select which env file
to load. It defaults to `.env.prod` if not specified.

### pnpm scripts

All Docker operations have convenience scripts in the root `package.json`:

| Script | Command | Description |
|---|---|---|
| `pnpm docker:dev` | `ENV_FILE=.env.dev docker compose up --build -d` | Build and start with dev env |
| `pnpm docker:prod` | `docker compose up --build -d` | Build and start with prod env (default) |
| `pnpm docker:down` | `docker compose down` | Stop all containers |
| `pnpm docker:logs` | `docker compose logs -f` | Tail logs for all services |
| `pnpm docker:logs:api` | `docker compose logs -f api` | Tail API logs |
| `pnpm docker:logs:worker` | `docker compose logs -f worker` | Tail worker logs |
| `pnpm docker:ps` | `docker compose ps` | Show container status |
| `pnpm docker:restart` | `docker compose restart` | Restart all containers |
| `pnpm docker:rebuild` | `docker compose up --build -d --force-recreate` | Force rebuild all containers |
| `pnpm docker:db:push` | `docker compose exec api npx prisma db push ...` | Push schema to DB inside container |

### Running with different environments

```bash
# Production (default — uses .env.prod)
pnpm docker:prod

# Development (uses .env.dev)
pnpm docker:dev

# Or manually:
ENV_FILE=.env.dev docker compose up --build -d
```

### How it works

The `env_file` directive in each service uses `${ENV_FILE:-.env.prod}`:
- If `ENV_FILE` is set in the shell, that file is used
- If not set, falls back to `.env.prod`

The `environment:` block in each service overrides specific vars for Docker
networking (e.g. `REDIS_URL=redis://redis:6379`), regardless of which env file
is loaded.

The web port is also configurable: `WEB_PORT=8080 docker compose up` to use
port 8080 instead of 80.

### Deployment Steps (First Time)

```bash
# 1. Clone and configure
git clone <repo>
cp .env.example .env.prod
# Edit .env.prod:
#   DATABASE_URL=postgresql://user:pass@your-pg-host:5432/aice_whatsapp
#   MINIO_ENDPOINT=your-minio-host
#   MINIO_PORT=9000
#   MINIO_ACCESS_KEY=...
#   MINIO_SECRET_KEY=...
#   MINIO_BUCKET=whatsapp-automation
#   ANTHROPIC_API_KEY=sk-ant-...
#   DATA_FOLDER=/app/data
#   (other vars as needed)

# 2. Build and start (production)
docker compose up --build -d

# Or for dev:
# ENV_FILE=.env.dev docker compose up --build -d

# 3. Run database schema push (first deploy)
docker compose exec api npx prisma db push \
  --schema=packages/api/prisma/schema.prisma

# 4. Create MinIO bucket (if not exists)
# The app auto-creates the bucket on startup via ensureBucket()

# 5. Access the UI
# Web UI: http://your-server:80 (or WEB_PORT if overridden)
# VNC (for QR scanning): vnc://your-server:5900

# 6. Create agents via the UI and scan QR codes
# Option A: Use the Agents page -- screenshot auto-refreshes every 15s during QR state
# Option B: Connect a VNC client to port 5900 and scan directly
```

### Subsequent deploys

```bash
git pull
docker compose up --build -d

# If schema changed:
docker compose exec api npx prisma migrate deploy \
  --schema=packages/api/prisma/schema.prisma
```

---

## 6. Data Migration: MySQL to PostgreSQL

Migration script: `scripts/migrate-mysql-to-pg.sh`

### Overview

All existing data in the local MySQL database must be transferred to the
production PostgreSQL instance. The migration covers 13 tables:

| Table | Key considerations |
|---|---|
| `Agent` | `id` is `autoincrement` -- sequence must be reset after import |
| `Department` | `id` is `cuid()` -- string IDs, no sequence issues |
| `Area` | `id` is `cuid()`, has `Json?` column (`columnMapping`) |
| `Contact` | Largest table -- may have 100k+ rows |
| `Campaign` | `template` is `@db.Text` |
| `CampaignArea` | Composite PK `(campaignId, areaId)` |
| `Message` | `body` and `failReason` are `@db.Text`, high row count |
| `Reply` | `claudeRaw` is `Json?`, `screenshotPath` values preserved as-is |
| `DailySendLog` | Composite unique `(agentId, date)` |
| `AppConfig` | Singleton row with `id = 'singleton'` |
| `WarmSession` | -- |
| `WarmSessionAgent` | Composite PK `(warmSessionId, agentId)` |
| `WarmExchange` | `message` and `replyMessage` are `@db.Text` |

### Prerequisites

1. PostgreSQL database created and accessible
2. Prisma schema already pushed to PostgreSQL:
   ```bash
   DATABASE_URL="postgresql://..." npx prisma db push \
     --schema=packages/api/prisma/schema.prisma
   ```
3. `pgloader` installed (recommended):
   ```bash
   # Ubuntu
   sudo apt install pgloader
   # macOS
   brew install pgloader
   ```

### Running the migration

```bash
MYSQL_URL="mysql://root:password@localhost:3306/aice_whatsapp" \
PG_URL="postgresql://postgres:password@your-pg-host:5432/aice_whatsapp" \
bash scripts/migrate-mysql-to-pg.sh
```

**What the script does:**

1. **With pgloader (recommended):** Directly streams data from MySQL to
   PostgreSQL with automatic type mapping (tinyint -> boolean, auto_increment ->
   serial, identifier quoting). Handles all 13 tables in one pass.

2. **Without pgloader (fallback):** Exports each table via `mysqldump` to SQL
   files in `/tmp/aice-migration-*/`. These require manual editing for
   PostgreSQL compatibility before import.

3. **Post-migration:** Resets the `Agent.id` sequence, sets all agent statuses
   to `OFFLINE`, and prints row count verification.

### Post-migration SQL (run manually)

After the migration script completes, apply these fixes:

```sql
-- 1. Fix Agent.profilePath for Docker environment
UPDATE "Agent" SET "profilePath" = '/app/browser-profiles/agent-' || id;

-- 2. Reset all agent statuses (browser profiles are not migrated)
UPDATE "Agent" SET status = 'OFFLINE';

-- 3. Fix Agent.id sequence (pgloader should handle this, but verify)
SELECT setval('"Agent_id_seq"', COALESCE((SELECT MAX(id) FROM "Agent"), 0) + 1);

-- 4. Verify row counts
SELECT 'Agent' AS tbl, COUNT(*) FROM "Agent"
UNION ALL SELECT 'Department', COUNT(*) FROM "Department"
UNION ALL SELECT 'Area', COUNT(*) FROM "Area"
UNION ALL SELECT 'Contact', COUNT(*) FROM "Contact"
UNION ALL SELECT 'Campaign', COUNT(*) FROM "Campaign"
UNION ALL SELECT 'CampaignArea', COUNT(*) FROM "CampaignArea"
UNION ALL SELECT 'Message', COUNT(*) FROM "Message"
UNION ALL SELECT 'Reply', COUNT(*) FROM "Reply"
UNION ALL SELECT 'DailySendLog', COUNT(*) FROM "DailySendLog"
UNION ALL SELECT 'AppConfig', COUNT(*) FROM "AppConfig"
UNION ALL SELECT 'WarmSession', COUNT(*) FROM "WarmSession"
UNION ALL SELECT 'WarmSessionAgent', COUNT(*) FROM "WarmSessionAgent"
UNION ALL SELECT 'WarmExchange', COUNT(*) FROM "WarmExchange"
ORDER BY 1;
```

### Type mapping notes

| MySQL type | PostgreSQL type | Notes |
|---|---|---|
| `INT AUTO_INCREMENT` | `SERIAL` | Agent.id only |
| `VARCHAR(500)` | `VARCHAR(500)` | Direct mapping |
| `TEXT` | `TEXT` | Direct mapping |
| `JSON` | `JSONB` | PostgreSQL uses binary JSON |
| `TINYINT(1)` | `BOOLEAN` | `warmMode`, `isWarmed`, `phoneValid`, etc. |
| `DATETIME` | `TIMESTAMP` | Direct mapping |
| `DOUBLE` | `DOUBLE PRECISION` | `expectedReplyRate` |

### What is NOT migrated

- **Browser profiles** -- Chromium profiles are tied to the local machine.
  New QR scans are required per agent on the Docker deployment.
- **Redis data** -- BullMQ jobs and ephemeral screenshots. Not needed in
  production; fresh Redis starts clean.

---

## 7. Data Migration: OUTPUT_FOLDER to MinIO

Migration script: `scripts/migrate-screenshots-to-minio.ts`

### Overview

All existing files in the local `OUTPUT_FOLDER` must be uploaded to MinIO so
that historical reply screenshots and reports continue to work.

| Source path | MinIO key | Content |
|---|---|---|
| `OUTPUT_FOLDER/screenshots/*.jpg` | `screenshots/*.jpg` | Reply screenshots |
| `OUTPUT_FOLDER/*.xlsx` | `reports/*.xlsx` | Daily response exports |
| `OUTPUT_FOLDER/{Type}/{Dept}/*.csv` | `reports/{Type}/{Dept}/*.csv` | Per-area CSV reports |

### Key compatibility

The `Reply.screenshotPath` field in the database already stores relative paths
like `screenshots/628xxx_2026-01-01T12-00-00.jpg`. The new code uses the same
key format when uploading to MinIO. So after migration, existing DB records point
to valid MinIO objects without any DB updates.

### Prerequisites

1. MinIO is running and accessible
2. The `minio` npm package is installed (`pnpm install`)
3. Env vars set: `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_ACCESS_KEY`,
   `MINIO_SECRET_KEY`, `MINIO_BUCKET`, and `OUTPUT_FOLDER` (pointing to the
   old local directory)

### Running the migration

```bash
# From the project root, with env file loaded:
dotenv -e .env.dev -- tsx scripts/migrate-screenshots-to-minio.ts

# Or set env vars inline:
OUTPUT_FOLDER=/path/to/data-output \
MINIO_ENDPOINT=your-minio-host \
MINIO_PORT=9000 \
MINIO_ACCESS_KEY=minioadmin \
MINIO_SECRET_KEY=minioadmin \
MINIO_BUCKET=whatsapp-automation \
tsx scripts/migrate-screenshots-to-minio.ts
```

**What the script does:**

1. Scans `OUTPUT_FOLDER/screenshots/` for all `.jpg`, `.jpeg`, `.png` files
2. Uploads each file to MinIO under the key `screenshots/{filename}`
3. Scans `OUTPUT_FOLDER/` for `.csv` and `.xlsx` report files (excluding
   screenshots directory)
4. Uploads report files to MinIO under `reports/{relative-path}`
5. Skips files that already exist in MinIO (idempotent -- safe to re-run)
6. Prints summary: uploaded / skipped / failed counts

### Post-migration verification

```bash
# Check MinIO bucket contents via mc (MinIO Client)
mc alias set local http://your-minio-host:9000 minioadmin minioadmin
mc ls local/whatsapp-automation/screenshots/ | head -20
mc ls local/whatsapp-automation/reports/ --recursive

# Verify count matches local
mc ls local/whatsapp-automation/screenshots/ | wc -l
ls OUTPUT_FOLDER/screenshots/ | wc -l
```

### Cleanup (after verification)

Once you confirm all screenshots load correctly in the UI:

1. Remove `OUTPUT_FOLDER` from `.env.prod` (no longer needed)
2. Optionally delete the local `OUTPUT_FOLDER/screenshots/` directory
3. Keep `OUTPUT_FOLDER` in `.env.dev` if you want local dev to still work
   (the scripts/ migration tool needs it)

---

## 8. Agent Browser Profiles

### Why profiles can't be migrated

Chromium browser profiles are binary blobs tied to the specific OS, Chromium
version, and file system. The macOS profiles will not work in the Linux Docker
container. Each agent requires a **new QR scan** on the Docker deployment.

### What to do

1. After Docker is running and agents are migrated in the DB, start each agent
   from the Agents page
2. The agent will show `QR` status with a scannable QR code in the expanded
   screenshot area (288x288px)
3. Alternatively, connect a VNC client to `server:5900` and scan the QR code
   from the virtual display
4. The QR scan persists in the Docker volume `browser_profiles` -- it survives
   container restarts

### Redis URL note

The local dev setup uses port `6380` (via `redis/redis.conf`). Docker Compose
runs Redis on the default `6379` internally. The `REDIS_URL` override in
docker-compose.yml handles this -- no code changes needed.

---

## 9. Complete Migration Runbook

Execute these steps in order for a full migration from local macOS to Docker:

```bash
# ─── Step 1: Prepare PostgreSQL ──────────────────────────────────────────────
# Create the database on your PostgreSQL server
psql "postgresql://postgres:password@pg-host:5432" -c "CREATE DATABASE aice_whatsapp;"

# Push the schema
DATABASE_URL="postgresql://postgres:password@pg-host:5432/aice_whatsapp" \
  npx prisma db push --schema=packages/api/prisma/schema.prisma

# ─── Step 2: Migrate MySQL data ─────────────────────────────────────────────
MYSQL_URL="mysql://root:password@localhost:3306/aice_whatsapp" \
PG_URL="postgresql://postgres:password@pg-host:5432/aice_whatsapp" \
bash scripts/migrate-mysql-to-pg.sh

# ─── Step 3: Post-migration SQL fixes ───────────────────────────────────────
psql "postgresql://postgres:password@pg-host:5432/aice_whatsapp" <<'SQL'
UPDATE "Agent" SET "profilePath" = '/app/browser-profiles/agent-' || id;
UPDATE "Agent" SET status = 'OFFLINE';
SELECT setval('"Agent_id_seq"', COALESCE((SELECT MAX(id) FROM "Agent"), 0) + 1);
SQL

# ─── Step 4: Migrate screenshots to MinIO ────────────────────────────────────
OUTPUT_FOLDER=/path/to/data-output \
MINIO_ENDPOINT=your-minio-host \
MINIO_PORT=9000 \
MINIO_ACCESS_KEY=minioadmin \
MINIO_SECRET_KEY=minioadmin \
MINIO_BUCKET=whatsapp-automation \
tsx scripts/migrate-screenshots-to-minio.ts

# ─── Step 5: Configure Docker ───────────────────────────────────────────────
cp .env.example .env.prod
# Edit .env.prod with production values:
#   DATABASE_URL=postgresql://...
#   MINIO_ENDPOINT=...
#   ANTHROPIC_API_KEY=...
#   DATA_FOLDER=/app/data
#   etc.

# ─── Step 6: Build and deploy ───────────────────────────────────────────────
docker compose --env-file .env.prod up --build -d

# ─── Step 7: Verify database connectivity ────────────────────────────────────
docker compose logs api | head -30
# Should show: "All checks passed"

# ─── Step 8: Re-scan QR codes for each agent ────────────────────────────────
# Open the web UI at http://your-server:80
# Go to Agents page → Start each agent → Scan QR code from the screenshot
# Or connect VNC client to your-server:5900

# ─── Step 9: Verify screenshots ─────────────────────────────────────────────
# Go to Responses page → click camera icon on any reply with a screenshot
# Should redirect to MinIO presigned URL and display the image

# ─── Step 10: Verify export ─────────────────────────────────────────────────
# Go to Responses page → Export → "Upload to MinIO"
# Check MinIO bucket for the new file
```

---

## 10. Security Considerations

- **VNC has no password** (`-nopw` flag) -- intended for internal/VPN access only.
  For production, either:
  - Restrict port 5900 to your VPN/internal network
  - Add `-passwd /path/to/passwd` to x11vnc args
  - Use SSH tunneling (`ssh -L 5900:localhost:5900 server`)

- **MinIO presigned URLs** expire after 1 hour. No long-lived public URLs are
  generated.

- **CORS_ORIGIN** is set to `*` in the Compose file. For production, restrict to
  your actual domain.

- **Sensitive env vars** (API keys, DB credentials, MinIO secrets) are passed via
  `.env.prod` file, not baked into images.

---

## 11. Files Changed Summary

### New files created

| File | Purpose |
|---|---|
| `packages/worker/src/lib/minio.ts` | MinIO client (worker) |
| `packages/api/src/lib/minio.ts` | MinIO client (api) |
| `docker/Dockerfile.api` | API container |
| `docker/Dockerfile.worker` | Worker container (Playwright + Xvfb + VNC) |
| `docker/Dockerfile.web` | Web container (Vite build -> Nginx) |
| `docker/nginx.conf` | Nginx config (static + API proxy + SSE) |
| `docker/worker-entrypoint.sh` | Worker startup: Xvfb -> x11vnc -> node |
| `docker-compose.yml` | Service orchestration |
| `.dockerignore` | Docker build exclusions |
| `scripts/migrate-mysql-to-pg.sh` | MySQL -> PostgreSQL data migration |
| `scripts/migrate-screenshots-to-minio.ts` | OUTPUT_FOLDER -> MinIO file migration |

### Files modified

| File | Change |
|---|---|
| `packages/api/prisma/schema.prisma` | `provider = "mysql"` -> `provider = "postgresql"` |
| `packages/api/package.json` | Removed `mysql2`, added `minio` |
| `packages/api/src/lib/validate.ts` | PostgreSQL URL check, MinIO connectivity check, removed OUTPUT_FOLDER |
| `packages/api/src/routes/replies.ts` | Presigned URL redirect instead of sendFile |
| `packages/api/src/lib/report.ts` | CSV upload to MinIO instead of fs.writeFileSync |
| `packages/api/src/lib/report-xlsx.ts` | Fetch screenshots from MinIO instead of fs.readFileSync |
| `packages/api/src/lib/exporter.ts` | XLSX upload to MinIO instead of fs.writeFileSync |
| `packages/worker/package.json` | Added `minio` |
| `packages/worker/src/index.ts` | Added `ensureBucket()` call at startup |
| `packages/worker/src/lib/agent-manager.ts` | Screenshot during QR state |
| `packages/worker/src/lib/browser-agent.ts` | Upload screenshots to MinIO instead of disk |
| `packages/worker/src/lib/validate.ts` | PostgreSQL URL check |
| `packages/web/src/pages/Agents.tsx` | Enlarged QR screenshot, dynamic thumbnail size |
| `packages/web/src/pages/Responses.tsx` | Updated button label "Upload to MinIO" |
| `.env.example` | Added MinIO vars, updated DATABASE_URL to PostgreSQL, removed OUTPUT_FOLDER |
