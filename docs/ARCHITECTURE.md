# Architecture

## Overview

The Rakuten Telegram Credential Checker is a distributed system for validating Rakuten account credentials. It uses a coordinator/worker architecture with Redis for task queuing and coordination.

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Coordinator   │    │   POW Service   │    │     Redis       │
│  (Telegram Bot) │◄──►│ (Proof of Work) │    │ (Coordination)  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
        │                                              ▲
        │                                              │
┌───────┴─────────┐                                    │
│ Telegram Bot API │ (optional, local server)          │
│  (>20MB uploads) │                                    │
└─────────────────┘                                    │
        │                                              │
        ▼                                              │
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│    Worker 1     │    │    Worker 2     │    │    Worker N     │
│ (Credential     │    │ (Credential     │    │ (Credential     │
│  Checking)      │    │  Checking)      │    │  Checking)      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## Service Boundaries

### Coordinator Service
**Entry**: `src/coordinator/index.js`

Owns: Telegram bot (`src/telegram/`), job orchestration, progress tracking, channel forwarding, proxy pool management, Prometheus metrics.

Key files:
- `index.js` — Service entrypoint (env validation, Redis, Telegram bot, shutdown)
- `Coordinator.js` — Main orchestrator (heartbeats, pub/sub, metrics, crash recovery)
- `JobQueueManager.js` — Redis-based task queue
- `ProgressTracker.js` — Batch progress tracking with Telegram message updates
- `ProxyPoolManager.js` — Round-robin proxy assignment with health checks
- `ChannelForwarder.js` — Distributed channel forwarding via pub/sub events
- `MetricsManager.js` / `MetricsServer.js` — Prometheus metrics collection and HTTP endpoint

Telegram handlers (`src/telegram/`):
- `telegramHandler.js` — Bot setup, command registration (`.chk`, `/start`, `/help`, `/stop`, `.proxy`, etc.)
- `batch/` — File upload, batch executor, circuit breaker, domain filters
- `combineHandler.js` / `combineBatchRunner.js` — Combine mode UX
- `configHandler.js` — `/config` command (centralized config)
- `exportHandler.js` — `/export` command (export VALID creds as file)
- `statusHandler.js` — `/status` command (system health)
- `channelForwarder.js` / `channelForwardStore.js` — Single-mode channel forwarding and dedup
- `messageTracker.js` — Forwarded message tracking
- `messages/` — MarkdownV2 helpers and message builders

**Critical patterns**: Long work in Telegram callbacks must use `setTimeout(() => runAsync(), 0)` to avoid Telegraf timeout. Always use `{ parse_mode: 'MarkdownV2' }` with `escapeV2`/`codeV2`/`boldV2` helpers. Close sessions in `.chk` even on errors.

Depends on: Redis, shared modules. Does NOT own: credential checking logic, POW computation.

### Worker Service
**Entry**: `src/worker/index.js`

Owns: task execution (credential checking via HTTP flow), POW computation (local or via POW service), result storage (processed store), progress reporting, heartbeat management.

Key files:
- `index.js` — Service entrypoint (Redis connection, task dequeue)
- `WorkerNode.js` — Worker execution loop (pops tasks, checks credentials, publishes results)
- `processTaskDirect.js` — Core task execution path (also reused by the local `test-full-flow.js` harness)
- `heartbeat.js` — Heartbeat payload build/send to Redis
- `httpServer.js` — Worker HTTP health/status/metrics endpoints (`GET /health`, `/status`, `/metrics`, `/`)
- `workerErrors.js` — Fatal vs transient error classification

Configuration: `WORKER_CONCURRENCY` (default 3), `WORKER_TASK_TIMEOUT` (120s), `POW_SERVICE_URL` (optional, falls back to local).

Depends on: Redis, shared modules, HTTP checker. Does NOT own: Telegram bot, job queue management.

### POW Service
**Entry**: `src/pow-service/index.js`

Standalone HTTP service for Proof-of-Work computation.

API endpoints:
- `POST /compute` — Compute POW cres value: `{ mask, key, seed }` → `{ cres, cached, computeTimeMs }`
- `GET /health` — Health check (status, uptime, hash implementation, redis, worker pool)
- `GET /metrics` — Prometheus metrics (`pow_requests_total`, `pow_cache_hit_rate`, `pow_uptime_seconds`)

Configuration: `PORT` (default 3001 for local runs; Docker sets `PORT=8080` and publishes `8080:8080` for compose / `8080:3001` for EC2), `REDIS_URL` (optional for caching), `POW_NUM_WORKERS` (CPU-1).

Key file: `index.js` — Single-file service with inline POWService class (worker thread pool, Redis cache).

Optional Redis dependency (caching only). Does NOT own: credential checking, Telegram bot.

### Telegram Bot API Server (Optional)
**Docker image**: `aiogram/telegram-bot-api:latest`

Optional local Bot API server that increases the file download limit from 20MB to 2000MB. When `TELEGRAM_API_ROOT` is set on the coordinator, the bot routes all Telegram API calls through this server instead of the cloud API.

Requires `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from https://my.telegram.org. Runs with `--local` mode (`TELEGRAM_LOCAL=1`) which enables large file downloads. The server's data directory (`/var/lib/telegram-bot-api`) is shared with the coordinator via a named volume so that `file://` URLs from `getFileLink` can be read directly from the filesystem.

Configuration: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_BOT_TOKEN` (for healthcheck), `TELEGRAM_LOCAL=1`, `TELEGRAM_HTTP_PORT=8081`.

Depends on: nothing. The coordinator depends on this service when `TELEGRAM_API_ROOT` is configured.

### Shared Modules
All live under `src/shared/`.

| Module | Purpose | Key Files |
|--------|---------|-----------|
| **Config** | Env validation, centralized config service (Redis pub/sub hot-reload) | `environment.js`, `configService.js`, `configSchema.js` |
| **Logger** | Structured logging with scoped loggers | `logger.js`, `structured.js` |
| **Redis** | ioredis wrapper, key schema | `client.js`, `keys.js` |
| **HTTP** | Axios client, login flow, response analyzer, session manager | `checker.js`, `client.js`, `flow.js`, `analyzer.js` |
| **Batch** | File parsing, domain filters, Redis dedup store | `parse.js`, `processedStore.js`, `constants.js` |
| **Fingerprinting** | POW challenge algorithm, POW service client, worker pool, bio/rat generators | `challengeGenerator.js`, `powServiceClient.js`, `powWorkerPool.js` |
| **Capture** | Account data capture (API + HTML), profile/order data | `apiCapture.js`, `htmlCapture.js`, `profileData.js` |
| **Payloads** | Request payload builders | `authorizeRequest.js`, `bioPayload.js`, `ratPayload.js` |
| **Errors** | Custom error classes | `AppError.js`, `RetryableError.js`, `TimeoutError.js`, `ValidationError.js` |
| **Constants** | Status codes, batch states, TTL/key defaults | `statusCodes.js`, `defaults.js`, `index.js` |
| **Utils** | Retry with backoff, TTL map | `retryWithBackoff.js`, `mapWithTtl.js` |

**Rule**: Services can import from `src/shared/` but `src/shared/` cannot import from services. `src/telegram/` can import from `src/shared/`. No circular dependencies.

## Data Flow

### Single Credential Check
1. Telegram → Coordinator parses `.chk` command
2. Coordinator → HTTP checker flow (navigate → email step → password step → detect outcome)
3. On VALID: capture account data → build result → channel forward (dedup via `channelForwardStore`)

### Batch Processing
1. Upload file → batch handler parses → filter already processed (MGET)
2. `setTimeout(...,0)` to detach → chunked processing with `BATCH_CONCURRENCY`
3. `markProcessedStatus` buffered; `updateProgress` throttled; summary with valid creds

### Distributed Queue
- **Coordinator**: `JobQueueManager.enqueueBatch` → tasks in Redis; `ProgressTracker.initBatch/startTracking` edits Telegram; `ChannelForwarder` listens to pub/sub `forward_events`.
- **Worker**: `WorkerNode` pops tasks, increments progress, publishes forward/update events.

## Redis Design

Redis serves as the single source of truth for coordination. Most keys are defined centrally in
`src/shared/redis/keys.js`; the two dedup stores (`proc:` / `fwd:`) define their prefixes locally.

| Purpose | Key Pattern | TTL |
|---------|-------------|-----|
| Task queue | `queue:tasks`, `queue:retry` | None |
| Task lease (in-flight) | `job:{batchId}:{taskId}` | 5 min |
| Progress tracking | `progress:{batchId}` (+ `:count`, `:counts`, `:valid`) | 7 days |
| Single-check dispatch result | `check:result:{taskId}`, `check:cancelled:{taskId}` | 120s |
| Batch cancellation flag | `batch:{batchId}:cancelled` | 1 hour |
| Processed credentials (dedup) | `proc:{status}:{email}:{password}` | 30 days |
| Result cache | `result:{status}:{email}:{password}` | 30 days |
| Channel forward dedup | `fwd:{email}:{password}` | 30 days |
| Forward two-phase commit | `forward:pending:{trackingCode}` | 2 min |
| Message tracking | `msg:{trackingCode}`, `msg:cred:{email}:{password}` | 30 days |
| Proxy health | `proxy:{proxyId}:health` | 5 min |
| Worker heartbeats / info | `worker:{id}:heartbeat`, `worker:{id}:info` | 30s / none |
| Coordinator heartbeat / lock | `coordinator:heartbeat`, `coordinator:lock:{op}` | 30s / 10s |
| POW cache | `pow:{mask}:{key}:{seed}` | 5 min |
| Config values | `config:{key}` | None |

Pub/sub channels: `forward_events`, `update_events`, `worker_heartbeats`.

> Note: TTLs above reflect `keys.js`; the cache TTLs `PROCESSED_TTL_MS` / `FORWARD_TTL_MS` (30-day defaults) are applied by `processedStore` / `channelForwardStore` at write time.

## Telegram Flow

1. Bot receives message → `telegramHandler.js` routes to command handler
2. `.chk` → `checkCredentials` → HTTP flow → result message (session closed even on error)
3. File upload → batch handler → parse → filter → queue to Redis
4. `/config` → config handler → get/set/reset config values
5. `/export` → export handler → send VALID credentials as file
6. `/status` → status handler → show system health

All outgoing messages use `{ parse_mode: 'MarkdownV2' }` with `escapeV2`/`codeV2`/`boldV2` helpers. Long-running work inside callbacks must be wrapped with `setTimeout(() => runAsync(), 0)` to avoid Telegraf's 10-second timeout.

## POW Flow

1. HTTP flow needs POW computation → `powServiceClient.computeCres()`
2. Client sends POST to POW service `/compute` endpoint
3. POW service computes using worker threads → returns result
4. If POW service unavailable → fallback to local computation
5. Results cached in Redis (POW service) or memory (local fallback)

## Module Dependency Rules

- Services (`src/coordinator/`, `src/worker/`, `src/pow-service/`) can import from `src/shared/`
- Services can import from `src/telegram/` (coordinator only)
- `src/shared/` modules cannot import from services
- `src/telegram/` modules can import from `src/shared/`
- No circular dependencies between modules
