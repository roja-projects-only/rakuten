# Agent Instructions — Rakuten Credential Checker Rewrite

## ⚠️ CRITICAL CONTEXT

This is a **clean rewrite from scratch** in a new workspace.

The legacy workspace at `../rakuten/` (or wherever the old codebase is located) is **reference material only**. Do NOT copy legacy code into this workspace. Do NOT continue the old architecture. Do NOT preserve deprecated patterns.

**Coordination mode is the only valid architecture.** Single-node mode is deprecated and must not be reimplemented.

---

## What This Project Is

A **distributed Rakuten Telegram Credential Checker** with three services:

1. **Coordinator** — Telegram bot + job queue management + progress tracking + channel forwarding
2. **Worker** — Consumes credential-checking tasks from Redis queue, publishes results
3. **POW Service** — Computes MurmurHash3 proof-of-work challenges via HTTP API

All services communicate through **Redis** (lists, hashes, pub/sub, keys with TTLs). There is no fallback mode. Redis is a hard requirement.

---

## Reference Pack Location

Legacy reference files are in `docs/reference/`. These are read-only historical artifacts — do not import them into source code.

```
docs/
├── reference/                    # ← Legacy source code (READ ONLY)
│   ├── coordinator/              # Coordinator modules
│   ├── worker/                   # Worker module
│   ├── pow-service/              # POW service entry + fingerprinting
│   ├── shared/                    # Redis client, keys, config, logger
│   ├── telegram/                 # Bot handlers, messages, batch UX
│   ├── automation/               # HTTP flow, capture, batch parsing
│   ├── docker/                   # Dockerfiles and compose
│   └── entry/                    # main.js, worker.js, pow-service.js, httpChecker.js
├── architecture/                 # ← Extracted architecture docs
│   ├── redis-key-schema.md       # Redis key patterns, TTLs, pub/sub channels
│   ├── service-contracts.md      # Inter-service communication contracts
│   ├── environment-variables.md  # Complete env var reference
│   └── data-flows.md             # Credential check, batch, channel forward flows
└── deployment/                   # ← Deployment reference
    ├── aws-setup-guide.md        # AWS EC2 deployment walkthrough
    ├── docker-compose-reference.yml
    └── systemd-units/             # coordinator.service, worker.service, pow-service.service
```

Root-level documents:
```
PROJECT_FOUNDATION_FOR_REWRITE.md   # Full audit findings
REWRITE_PLAN.md                     # Rewrite plan, priorities, module mapping
AGENT-NEW.md                         # ← This file
```

---

## How to Use the Reference Pack

### ✅ DO

- Read reference files to understand **what the system does** and **why**
- Use `docs/reference/shared/redis/keys.js` as the **authoritative source** for Redis key patterns, TTLs, and pub/sub channel names — these are the inter-service contracts
- Use `docs/reference/shared/config/configSchema.js` to understand which variables are hot-reloadable and their validation rules
- Use `docs/reference/automation/http/httpFlow.js` and `capture/` to understand the Rakuten login flow sequence and data capture requirements
- Use `docs/reference/shared/coordinator/Coordinator.js` to understand the orchestration responsibilities
- Use `docs/architecture/redis-key-schema.md` for a clean summary of all Redis keys without reading source
- Use `docs/architecture/data-flows.md` for credential check, batch, and channel forward flow diagrams

### ❌ DO NOT

- Copy-paste legacy code into new source files
- Recreate the `shared/compatibility/` directory or any single-node fallback logic
- Implement mode detection (no `COORDINATOR_MODE` flag — each service IS its mode)
- Port the `GracefulDegradation.js` or `SingleNodeMode.js` patterns
- Port the dual channel forwarder (`telegram/channelForwarder.js` — use only the coordinator version)
- Reuse the dual Redis client library pattern (pick `ioredis` only)
- Preserve JSONL file-based dedup fallback
- Keep empty catch blocks — every error must be logged at minimum debug level
- Hardcode any Rakuten URLs — make them all configurable via env vars

---

## Architecture Rules for the Rewrite

### Rule 1: Redis Is Required

No fallback mode. If Redis is down, the service fails fast with a clear error. No `GracefulDegradation`, no `SingleNodeMode`, no JSONL fallback.

### Rule 2: One Service, One Mode

Each service (coordinator, worker, POW) has a single entry point with a single mode. No `COORDINATOR_MODE` env var. The Dockerfile IS the mode.

### Rule 3: Single Redis Client

Use `ioredis` only. Remove the `redis` package. Do not introduce dual client libraries.

### Rule 4: Single Channel Forwarder

One implementation using Redis pub/sub. No in-memory fallback. The reference is `docs/reference/shared/coordinator/ChannelForwarder.js`.

### Rule 5: Explicit Configuration

Each service validates its own required env vars at startup and exits with a clear error if missing. No auto-detection of mode.

### Rule 6: All URLs Configurable

All Rakuten endpoints, IP detection services, and internal service URLs must be env vars with sensible defaults. No hardcoded URLs.

### Rule 7: No Silent Errors

Every `catch` block must log at minimum debug level. No empty catch blocks.

### Rule 8: Preserve the Redis Key Schema

The Redis key patterns, TTLs, and pub/sub channel names in `docs/reference/shared/redis/keys.js` are the **inter-service contract**. The rewrite must use the same keys for compatibility during migration, or explicitly document every change.

### Rule 9: Preserve Critical Business Logic

The following must be faithfully reimplemented (logic, not code):

- **Two-phase commit for channel forwarding** — pending → send → confirm → cleanup
- **Worker task lease management** — SET NX EX for lease, Lua script for safe release
- **Zombie task recovery** — scan expired leases, re-enqueue orphaned tasks
- **Coordinator crash recovery** — resume incomplete batches, retry pending forwards
- **Circuit breaker** — 60% error threshold, 5-result window, 3s pause
- **Proxy rotation with health tracking** — round-robin, 3-strike unhealthy, auto-restore
- **POW challenge computation** — MurmurHash3 cres algorithm with caching
- **Credential deduplication** — MGET batch lookups against result cache, 30-day TTL
- **Progress throttling** — 8-second Telegram update throttle to avoid rate limits
- **Hot-reloadable config** — Redis pub/sub propagation for runtime config changes

### Rule 10: Test Infrastructure First

Set up the test runner (Vitest recommended) before writing application code. No orphan `.test.js` files without a runner.

---

## Key Reference Files

These are the most important files in the reference pack. Read them first:

| Priority | File | Why |
|----------|------|-----|
| 🔴 Critical | `docs/reference/shared/redis/keys.js` | Inter-service contract: all Redis keys, TTLs, generators, pub/sub channels |
| 🔴 Critical | `docs/reference/shared/coordinator/Coordinator.js` | Core orchestration: startup, shutdown, crash recovery, worker monitoring |
| 🔴 Critical | `docs/reference/shared/coordinator/JobQueueManager.js` | Task distribution: enqueue, dedup, retry, cancel |
| 🔴 Critical | `docs/reference/shared/worker/WorkerNode.js` | Worker loop: dequeue, lease, process, store, publish, release |
| 🔴 Critical | `docs/reference/shared/coordinator/ChannelForwarder.js` | Two-phase commit forwarding, status updates |
| 🔴 Critical | `docs/reference/automation/http/httpFlow.js` | Login flow: navigate → email → password → detect outcome |
| 🟡 Important | `docs/reference/shared/coordinator/ProgressTracker.js` | Batch progress tracking, throttled Telegram updates |
| 🟡 Important | `docs/reference/shared/coordinator/ProxyPoolManager.js` | Proxy rotation, health tracking |
| 🟡 Important | `docs/reference/shared/config/configSchema.js` | 15 hot-reloadable config variables with validation |
| 🟡 Important | `docs/reference/shared/config/configService.js` | Redis pub/sub config propagation |
| 🟡 Important | `docs/reference/automation/http/fingerprinting/challengeGenerator.js` | POW cres algorithm |
| 🟡 Important | `docs/reference/automation/http/capture/apiCapture.js` | Points/Cash/Rank data capture |
| 🟡 Important | `docs/reference/telegram/messages/helpers.js` | MarkdownV2 formatting (escapeV2, codeV2, boldV2, spoilerCodeV2) |
| 🟡 Important | `docs/reference/pow-service.js` | POW service entry, worker pool, caching |
| 🟢 Useful | `docs/reference/shared/coordinator/MetricsManager.js` | Prometheus metrics collection |
| 🟢 Useful | `docs/reference/shared/coordinator/MetricsServer.js` | /metrics and /health endpoints |
| 🟢 Useful | `docs/reference/automation/http/htmlAnalyzer.js` | Response outcome detection |
| 🟢 Useful | `docs/reference/telegram/batch/batchExecutor.js` | Batch execution flow (distributed path only) |
| 🟢 Useful | `docs/reference/telegram/batch/circuitBreaker.js` | Error rate monitoring pattern |
| 🟢 Useful | `docs/reference/docker/docker-compose.yml` | Service orchestration reference |

---

## Deprecated — Do Not Reimplement

The following are documented here so you recognize them and avoid accidentally recreating them:

| Pattern | Where in Legacy | Why Deprecated |
|---------|----------------|----------------|
| Single-node mode | `shared/compatibility/SingleNodeMode.js` | In-memory queue, no persistence, no scaling |
| Graceful degradation | `shared/compatibility/GracefulDegradation.js` | Fallback to single-node when Redis unavailable |
| Compatibility facade | `shared/compatibility/index.js` | Mode detection and single-node init path |
| Single-node channel forwarder | `telegram/channelForwarder.js` | Duplicate of coordinator version, in-memory |
| JSONL dedup fallback | `automation/batch/processedStore.js` (JSONL path) | File-based fallback when Redis unavailable |
| `runSingleNodeBatch()` | `telegram/batch/batchExecutor.js` | Inline batch processing without Redis |
| `COORDINATOR_MODE` env var | `shared/config/environment.js` | Mode detection — each service IS its mode |
| `isDistributedMode()` / `isSingleNodeMode()` | `shared/config/environment.js` | Mode detection functions |
| Dual Redis client libraries | `package.json` (ioredis + redis) | Use ioredis only |
| `processBatchLegacy()` | `shared/compatibility/index.js` | Legacy batch processing path |

---

## Service Boundaries

```
┌─────────────────────────────────────────────────────────┐
│                    COORDINATOR                           │
│  Telegram Bot │ Job Queue │ Progress │ Channel Forward   │
│  Proxy Pool   │ Config    │ Metrics  │ Crash Recovery   │
└──────────────────────────┬──────────────────────────────┘
                           │ Redis
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
     ┌──────────┐   ┌──────────┐   ┌──────────┐
     │ WORKER 1 │   │ WORKER 2 │   │ WORKER N │
     │ HTTP Flow│   │ HTTP Flow│   │ HTTP Flow│
     │ POW      │   │ POW      │   │ POW      │
     └──────────┘   └──────────┘   └──────────┘
                           │
                    ┌──────┴──────┐
                    │ POW SERVICE │
                    │ Worker Pool │
                    └─────────────┘
```

### Coordinator (required env: REDIS_URL, TELEGRAM_BOT_TOKEN, TARGET_LOGIN_URL)
- Telegram bot: commands, callbacks, progress updates
- Job queue: enqueue, dedup, retry, cancel
- Progress tracking: throttled Telegram edits, summaries
- Channel forwarding: two-phase commit, status updates
- Proxy rotation: round-robin with health tracking
- Crash recovery: resume incomplete batches
- Metrics: Prometheus /metrics and /health on port 9090

### Worker (required env: REDIS_URL)
- Task dequeue: BLPOP from retry (priority) then tasks queue
- Lease management: SET NX EX, Lua release script
- Credential checking: HTTP login flow with POW
- Result storage: SETEX with 30-day TTL
- Event publishing: forward_events, update_events via pub/sub
- Heartbeat: every 10s via pub/sub and Redis key

### POW Service (optional env: REDIS_URL for caching)
- HTTP /compute endpoint for cres challenge
- Worker thread pool (CPU-1 threads)
- 5-minute result cache
- /health and /metrics endpoints

---

## Redis Key Schema (Inter-Service Contract)

This is the **single source of truth** for how services communicate. The rewrite must either preserve these keys exactly or document every change.

| Key Pattern | Type | TTL | Purpose |
|-------------|------|-----|---------|
| `queue:tasks` | LIST | — | Main job queue |
| `queue:retry` | LIST | — | Priority retry queue |
| `result:{status}:{email}:{password}` | STRING | 30d | Deduplication cache |
| `progress:{batchId}` | STRING | 7d | Batch progress metadata JSON |
| `progress:{batchId}:count` | STRING | 7d | Completed counter |
| `progress:{batchId}:counts` | HASH | 7d | VALID/INVALID/BLOCKED/ERROR counts |
| `progress:{batchId}:valid` | LIST | 7d | Valid credentials list |
| `job:{batchId}:{taskId}` | STRING | 5min | Task lease |
| `coordinator:heartbeat` | STRING | 30s | Coordinator liveness |
| `coordinator:lock:{operation}` | STRING | 10s | Distributed lock |
| `worker:{workerId}:heartbeat` | STRING | 30s | Worker liveness |
| `forward:pending:{trackingCode}` | STRING | 2min | Two-phase commit state |
| `msg:{trackingCode}` | STRING | 30d | Channel message reference |
| `msg:cred:{email}:{password}` | STRING | 30d | Reverse lookup for updates |
| `proxy:{proxyId}:health` | STRING | 5min* | Proxy health state |
| `pow:{mask}:{key}:{seed}` | STRING | 5min | POW cache |

| Pub/Sub Channel | Purpose |
|-----------------|---------|
| `forward_events` | Worker → Coordinator: forward VALID credential |
| `update_events` | Worker → Coordinator: status change (INVALID/BLOCKED) |
| `worker_heartbeats` | Worker → Coordinator: liveness signal |

*5min TTL for unhealthy proxies; no TTL for healthy.

---

## Environment Variables (Coordination Mode Only)

### Required
| Variable | Service | Purpose |
|----------|---------|---------|
| `REDIS_URL` | All | Redis connection URL |
| `TELEGRAM_BOT_TOKEN` | Coordinator | Bot token from @BotFather |
| `TARGET_LOGIN_URL` | Coordinator, Worker | Rakuten OAuth login URL |

### Important
| Variable | Default | Service | Purpose |
|----------|---------|---------|---------|
| `WORKER_CONCURRENCY` | 3 | Worker | Concurrent tasks per worker |
| `WORKER_TASK_TIMEOUT` | 120000 | Worker | Task timeout in ms |
| `WORKER_HEARTBEAT_INTERVAL` | 10000 | Worker | Heartbeat interval in ms |
| `POW_SERVICE_URL` | — | Worker, Coordinator | POW service endpoint |
| `FORWARD_CHANNEL_ID` | — | Coordinator | Telegram channel for VALID results |
| `ALLOWED_USER_IDS` | — | Coordinator | Authorized Telegram user IDs |
| `METRICS_PORT` | 9090 | Coordinator | Prometheus metrics port |
| `BATCH_MAX_RETRIES` | 2 | Coordinator | Max retries per credential |
| `PROXY_POOL` | — | Coordinator | Comma-separated proxy URLs |
| `PROCESSED_TTL_MS` | 30d | All | Dedup cache TTL |
| `LOG_LEVEL` | info | All | Logging level |

### POW Service
| Variable | Default | Purpose |
|----------|---------|---------|
| `POW_SERVICE_MODE` | false | Enable POW service mode |
| `PORT` | 3001 | HTTP port |
| `POW_NUM_WORKERS` | CPU-1 | Worker thread count |
| `POW_TASK_TIMEOUT` | 30000 | Task timeout in ms |

---

## Telegram Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message with quick-action buttons |
| `.chk user:pass` | Single credential check (auto capture on VALID) |
| `.proxy` | Show current proxy status |
| `.ulp <url>` | Process ULP data from URL |
| `/stop` | Abort active batch/combine |
| `/combine` | Multi-file upload → /done → type → confirm |
| `/config` | View/set hot-reloadable config |
| `/export` | Export VALID credentials |
| `/status` | System health |

---

## Critical Patterns to Preserve

### Telegram Callback Timeout
Long work inside Telegram callbacks must be wrapped with `setTimeout(() => { ... }, 0)` to avoid Telegraf's 90-second timeout.

### MarkdownV2 Formatting
Always use `parse_mode: 'MarkdownV2'` with helpers: `escapeV2`, `codeV2`, `boldV2`, `spoilerCodeV2`.

### Credential Masking
Never log or display full credentials. Use spoiler tags in Telegram.

### Session Cleanup
Always close HTTP sessions in `.chk` handlers, even on errors (use `finally` blocks).

### Deduplication
Use Redis-backed dedup for both processed credentials (`processedStore`) and forwarded messages (`channelForwardStore`).

### Two-Phase Commit for Forwarding
1. SET `forward:pending:{trackingCode}` (2min TTL)
2. Send message to Telegram channel
3. SET `msg:{trackingCode}` and `msg:cred:{email}:{password}` (30d TTL)
4. DEL `forward:pending:{trackingCode}`

### Worker Task Lease
1. BLPOP from `queue:retry` (priority) then `queue:tasks`
2. SET `job:{batchId}:{taskId}` with NX+EX (5min TTL)
3. Process credential
4. Store result, publish events
5. Release lease (Lua script for safe release)

---

## Rewrite Priorities

See `REWRITE_PLAN.md` for the full step-by-step sequence. Summary:

1. **Shared infrastructure** — Redis client, key schema, config, logger
2. **Worker service** — Task loop, HTTP flow, POW, result storage
3. **Coordinator service** — Job queue, progress, forwarding, proxy, crash recovery, Telegram bot
4. **POW service** — HTTP server, challenge computation, worker pool
5. **Integration testing** — End-to-end flows, crash recovery, failover
6. **Deployment** — Docker Compose, systemd, AWS

---

## Files NOT in the Reference Pack

The following legacy files are intentionally excluded from the reference pack because they are deprecated, duplicated, or tied to single-node architecture:

- `shared/compatibility/` — Entire directory (deprecated single-node fallback)
- `telegram/channelForwarder.js` — Single-node duplicate of coordinator version
- `automation/batch/http.js` — Unused `getWithRedirect()` function
- `automation/batchProcessor.js` — Thin re-export facade
- `shared/coordinator/index.js` — Barrel re-export
- `shared/worker/index.js` — Barrel re-export
- `scripts/migration/` — Completed migration scripts
- `scripts/setup/` — Overlapping Windows setup scripts
- `scripts/debug/` — Debug utilities
- `scripts/maintenance/emergency-clear-redis.js` — Hardcoded credentials
- `tools/rakuten-manager/` — Separate Go project
- `data/` — Runtime data
- `.env` — Contains live secrets
- `rakuten-key.pem`, `rakuten.pem`, `rakuten2.pem`, `rakuten.pub` — SSH keys
- `railway.json` — Railway-specific config
- `.cursor/`, `.kiro/`, `.vscode/` — IDE configs
- `node_modules/`, `package-lock.json` — Regenerate from scratch