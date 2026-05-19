# Agent Instructions for aice-whatsapp-automation

## Repository Overview

Monorepo for a WhatsApp automation system (campaign sending, reply polling, phone validation, warming).

- **Package manager**: pnpm@10.13.1 (required)
- **Workspace**: `packages/*` — `@aice/shared`, `@aice/api`, `@aice/worker`, `@aice/web`
- **Runtime**: Node.js + TypeScript. API & Worker use `tsx` for dev. Web uses Vite.

## Build / Dev Commands

```bash
# Install dependencies
pnpm install

# Dev (all packages in parallel)
pnpm dev

# Dev single package
pnpm dev:api      # API server (Express + Prisma)
pnpm dev:worker   # Worker (Playwright + BullMQ)
pnpm dev:web      # Vite React frontend

# Build (shared first, then rest in parallel)
pnpm build

# Build single package
pnpm --filter @aice/shared build
pnpm --filter @aice/api build      # tsc
pnpm --filter @aice/worker build   # tsc
pnpm --filter @aice/web build      # tsc -b && vite build

# Start production (built output)
pnpm start

# Type-check only (no separate lint/test commands exist)
pnpm --filter @aice/api exec tsc --noEmit
pnpm --filter @aice/worker exec tsc --noEmit
pnpm --filter @aice/web exec tsc --noEmit
```

## Database / Redis Commands

```bash
# Prisma (run from repo root — filters to @aice/api)
pnpm db:generate
pnpm db:push          # dev only (guarded in prod)
pnpm db:migrate
pnpm db:studio
pnpm db:fresh         # dev only (reset)

# Redis
pnpm redis:start      # prod config (port 6380)
pnpm redis:start:dev  # dev config (port 6379)
pnpm redis:stop
pnpm redis:flush:dev
```

## Testing

**No test runner is configured** (no Jest, Vitest, or Playwright tests). The only existing check is:

```bash
pnpm test:analyze   # runs src/lib/test-analyze.ts via tsx
```

If you add tests, prefer **Vitest** (aligns with Vite in web package) or **Node.js native test runner**.

## Code Style Guidelines

### TypeScript

- **Target**: ES2022 (web uses ES2020 + DOM). `strict: true` is enabled in all packages.
- **Module**: CommonJS (`Node10` resolution) for `api` / `worker` / `shared`. ESNext (`Bundler` resolution) for `web`.
- Use `import type` for type-only imports.
- Prefer `interface` over `type` for object shapes.
- Use `as const` for literal arrays (e.g. `['DRAFT', 'RUNNING'] as const`).
- Avoid `any`; use `unknown` or narrow with Zod.

### Formatting

- 2-space indentation.
- Single quotes for strings.
- No semicolons (omit where safe).
- Space after `//` in comments.
- Use `// ─── Section Name ─────────────────────────────────────` dividers between logical sections.

### Naming

- `camelCase`: variables, functions, methods, file names.
- `PascalCase`: classes, interfaces, types, React components, Zod schemas.
- `UPPER_SNAKE_CASE`: module-level constants and env-derived config values.
- Boolean flags: start with `is`, `has`, `allow`, `stop` (e.g. `stopOnTargetReached`).

### Imports (order)

1. Node built-ins (`fs`, `path`)
2. External packages (`express`, `bullmq`, `zod`)
3. Workspace packages (`@aice/shared`)
4. Relative imports (`../lib/db`, `./routes/campaigns`)

### API Routes (`packages/api/src/routes/`)

- Export `default router` (Express `Router`).
- Wrap route handlers in `try/catch`.
- Return JSON shape: `{ ok: true, data: T }` or `{ ok: false, error: string }`.
- Use Zod (`safeParse`) for body/query validation.
- Use `CAMPAIGN_STATUSES` / `MESSAGE_STATUSES` `as const` arrays for filtering.

### React (`packages/web/src/`)

- Functional components, default export per page.
- Path alias: `@/` maps to `src/` (configured in Vite + tsconfig).
- Utility: `cn(...)` from `@/lib/utils` for Tailwind class merging.
- Data fetching: `apiFetch<T>(path, init?)` from `@/lib/utils`.

### Worker (`packages/worker/src/`)

- `BrowserAgent` class handles Playwright automation per WhatsApp account.
- Prefer BullMQ `job.moveToDelayed()` over `sleep()` when rescheduling.
- Log prefix convention: `[worker]`, `[agent:${agentId}]`, `[poll]`, `[manual-send]`, `[warm-worker]`.
- Use `.catch(() => {})` for fire-and-forget side effects.

### Error Handling

- API: `res.status(500).json({ ok: false, error: String(err) })`
- Worker: `console.error('[worker] …', err)` + BullMQ `job.moveToDelayed()` when recoverable.
- Never throw raw objects; always throw `Error` instances.

### Database (Prisma)

- Schema lives in `packages/api/prisma/schema.prisma`.
- Use `db.$executeRaw` sparingly; prefer typed Prisma queries.
- Transactional updates (counters) should be idempotent or guarded with `GREATEST(x - y, 0)`.

## Environment Files

- `.env.dev` — used by `pnpm dev:*`
- `.env.prod` — used by `pnpm build` and `pnpm start`
- Copy `.env.example` to create either.

## Shared Types (`@aice/shared`)

Keep canonical types in `packages/shared/src/index.ts`. API and Worker import from here. Do not duplicate type definitions across packages.

## Important Notes

- `shared` must be built before `api`, `worker`, or `web` can import it.
- `BROWSER_HEADLESS` must stay `false` — WhatsApp Web requires a visible window.
- `redis` is required for BullMQ queues and agent status pub/sub.
- `db:push` and `db:fresh` are protected by `scripts/prod-guard.ts`; they will abort if `NODE_ENV=production`.
