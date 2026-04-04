# Redis Environment Separation — Specification

## Problem

Currently a single Redis instance (port `6380`) is shared by both dev and prod environments. Both `.env.dev` and `.env.prod` point to `REDIS_URL=redis://localhost:6380`. This means:

- Running `pnpm start` (prod) and `pnpm dev` simultaneously causes data collision
- Dev testing can accidentally pull or corrupt production queue data
- No isolation between environments for BullMQ queues, agent status, or warmer sessions

## Goal

Provide separate Redis instances for dev and prod, each on its own port, with matching npm scripts for start/stop/flush per environment.

## Changes

### 1. New Redis config for dev

Create `redis/redis-dev.conf` — identical to `redis/redis.conf` but on port `6379` with its own data dir:

```
port 6379
dir /Users/andriopratama/Projects/whatsapp-automation/redis/data-dev
```

The existing `redis/redis.conf` (port `6380`) becomes the **prod** instance.

### 2. New root scripts in `package.json`

| Script              | Command                                      | Purpose                          |
|---------------------|----------------------------------------------|----------------------------------|
| `redis:start`       | `redis-server redis/redis.conf`              | Start prod Redis (port 6380)     |
| `redis:start:dev`   | `redis-server redis/redis-dev.conf`          | Start dev Redis (port 6379)      |
| `redis:stop`        | `redis-cli -p 6380 shutdown`                 | Stop prod Redis                  |
| `redis:stop:dev`    | `redis-cli -p 6379 shutdown`                 | Stop dev Redis                   |
| `redis:flush`       | (prod-guard) `redis-cli -p 6380 FLUSHALL`    | Flush prod Redis                 |
| `redis:flush:dev`   | `redis-cli -p 6379 FLUSHALL`                 | Flush dev Redis (no guard needed)|

### 3. Update `.env.dev`

Change `REDIS_URL` to point to the dev instance:

```diff
-REDIS_URL=redis://localhost:6380
+REDIS_URL=redis://localhost:6379
```

`.env.prod` remains unchanged (`redis://localhost:6380`).

### 4. Update `.env.example`

Add a comment explaining the port convention:

```
# ─── Redis ────────────────────────────────────────────────────────────────────
# Dev:    redis://localhost:6379
# Prod:   redis://localhost:6380
REDIS_URL=redis://localhost:6379
```

### 5. Update `.gitignore`

Add the dev data directory:

```diff
 redis/data/
+redis/data-dev/
```

## File Summary

| File | Change |
|------|--------|
| `redis/redis-dev.conf` | **New** — dev Redis config (port 6379) |
| `redis/data-dev/` | **New** — dev data directory (gitignored) |
| `package.json` | **Modified** — add `:dev` variants of redis scripts |
| `.env.dev` | **Modified** — `REDIS_URL` → port 6379 |
| `.env.example` | **Modified** — update default + add comment |
| `.gitignore` | **Modified** — add `redis/data-dev/` |

## Usage

```bash
# Before running prod:
pnpm redis:start        # starts prod Redis on 6380
pnpm start              # uses .env.prod → connects to 6380

# Before running dev:
pnpm redis:start:dev    # starts dev Redis on 6379
pnpm dev                # uses .env.dev → connects to 6379

# Both can run simultaneously with zero data collision
```
