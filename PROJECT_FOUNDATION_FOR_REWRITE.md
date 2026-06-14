# Project Foundation for Rewrite

> **Document purpose**: Extract critical knowledge, context, architecture findings, workflows, constraints, and lessons from this abandoned workspace so a completely fresh rewrite can later be built from scratch. This is NOT a rewrite, refactor, or migration plan — it is a knowledge recovery document only.

---

# Executive Summary

This workspace is a **Rakuten Telegram Credential Checker** — a distributed system that validates Rakuten account credentials via HTTP (no browser), captures account data (points, rank, cash), and forwards valid results to a Telegram channel. It operates in two modes: a deprecated single-node mode and a coordination mode using Redis-based job queues with horizontal worker scaling. The rewrite foundation must preserve only the coordination-mode architecture.

The workspace contains significant dead weight: an entire single-node compatibility layer, duplicate channel forwarder implementations, stale migration/debug scripts, unused barrel exports, and dual Redis client libraries. The coordination-mode core is well-structured but tightly coupled to the single-node fallback through a compatibility facade.

**Confidence**: High — the workspace is well-documented (AI_CONTEXT.md, AGENTS.md, CLEANUP_REPORT.md) and the architecture is traceable through clear entry points and module boundaries.

---

# Project Identity

- **Name**: Rakuten Telegram Credential Checker
- **Purpose**: High-speed distributed Telegram bot for validating Rakuten account credentials with automatic points/rank/cash capture and horizontal scaling
- **Primary Interface**: Telegram bot (Telegraf framework)
- **Core Operation**: HTTP-based credential checking against Rakuten OAuth login flow (no browser/Puppeteer — 10-50x faster)
- **Deployment Targets**: AWS EC2 (primary), Docker Compose (local dev), Railway (legacy)
- **Runtime**: Node.js ≥20, Docker, Redis

---

# Workspace Health Assessment

| Aspect | Status | Notes |
|--------|--------|-------|
| Entry points | Functional | 4 clear entry points: main.js, worker.js, pow-service.js, httpChecker.js |
| Documentation | Good | AI_CONTEXT.md, AGENTS.md, CLEANUP_REPORT.md, docs/ |
| Test coverage | Moderate | 23 integration test scripts, no unit test runner configured |
| Dependency health | Fair | Dual Redis clients (ioredis + redis), unused deps (form-data, jest, test), missing dep (node-fetch) |
| Code organization | Fair | Mixed concerns in compatibility layer, duplicate implementations |
| Dead code | Significant | ~1,400 lines of single-node compatibility, unused barrel files, stale scripts |
| Security | Poor | Live secrets in .env, hardcoded Redis URL in maintenance script, hardcoded debug ingest endpoint |
| Docker config | Fair | Port convention drift (3001 vs 8080), no .dockerignore (now added per CLEANUP_REPORT) |

---

# Legacy Modes and Status

| Mode | Status | Label |
|------|--------|-------|
| **Coordinator** | Active, production | Preserve for rewrite |
| **Worker** | Active, production | Preserve for rewrite |
| **POW Service** | Active, production | Preserve for rewrite |
| **Single-node** | Deprecated fallback | Deprecated — Legacy reference only |
| **Single-node fallback** (GracefulDegradation) | Deprecated | Deprecated — Legacy reference only |

### Mode Detection Logic

Mode is determined by `shared/config/environment.js` → `getDeploymentMode()`:

1. `COORDINATOR_MODE=true` → coordinator
2. `POW_SERVICE_MODE=true` → pow-service
3. `REDIS_URL` set → worker
4. Otherwise → single (deprecated)

**For the rewrite**: Mode detection should be explicit per-service, not auto-detected. Each service (coordinator, worker, POW) should be a separate entry point with required env vars validated at startup.

---

# Coordination Mode Findings

## Startup Flow

### Coordinator (main.js with COORDINATOR_MODE=true)

```
1. dotenv.config()
2. createCompatibilityLayer()
   → validateEnvironment('auto') → mode='coordinator'
   → Redis connect + health check
   → initializeCoordinator()
     → new Coordinator(redisClient, null, options)
     → coordinator.start()
       → pub/sub Redis connection
       → progressTracker.subscribeToProgressEvents()
       → channelForwarder.start()
       → subscribeToWorkerHeartbeats()
       → start intervals: heartbeat (30s), health monitor (30s), zombie recovery (60s)
       → metricsManager.startPeriodicCollection(30s)
       → metricsServer.start() on port 9090
       → performCrashRecovery()
3. initConfigService() (optional, Redis-backed hot-reload)
4. initializeTelegramHandler(botToken, options)
5. Set telegram on coordinator instance
6. bot.launch()
```

### Worker (worker.js)

```
1. validateEnvironment() → requires REDIS_URL
2. initRedisClient()
3. Redis health check
4. initConfigService() (optional)
5. Test proxy connectivity (if PROXY_SERVER set)
6. new WorkerNode(redisClient, options)
7. worker.run()
   → registerWorker() → SET worker:{id}:info
   → startHeartbeat() → interval every 10s
   → startMetricsLogging() → interval every 30s
   → startHttpServer() → port 3010
   → Main loop: dequeueTask() → processTaskWithLease()
```

### POW Service (pow-service.js)

```
1. dotenv.config()
2. validateEnvironment('pow-service')
3. new POWService(options)
4. service.start()
   → Redis connect (optional, for caching)
   → workerPool.init() → spawns CPU-1 worker threads
   → app.listen(port 3001)
5. Graceful shutdown on SIGTERM/SIGINT
```

## Coordinator Responsibilities

The Coordinator (`shared/coordinator/Coordinator.js`, ~980 lines) is the central orchestrator:

1. **Job Queue Management**: Enqueues credential batches, deduplicates against result cache, distributes tasks to workers via Redis lists
2. **Progress Tracking**: Monitors batch completion, throttles Telegram updates (8s), sends summaries
3. **Channel Forwarding**: Two-phase commit for forwarding VALID credentials to Telegram channel, handles INVALID/BLOCKED updates
4. **Proxy Pool Management**: Round-robin proxy assignment with health tracking, auto-restores unhealthy proxies
5. **Worker Monitoring**: Subscribes to worker heartbeats via pub/sub, detects dead workers (30s threshold)
6. **Zombie Task Recovery**: Scans expired task leases every 60s, re-enqueues orphaned tasks
7. **Crash Recovery**: On startup, scans for in-progress batches, resumes tracking, retries pending forwards
8. **Distributed Locking**: Redis SETNX with Lua scripts for safe release, prevents duplicate operations
9. **Metrics Collection**: Prometheus-compatible metrics on port 9090

## Service Boundaries

| Service | Entry Point | Port | Dependencies |
|---------|-------------|------|-------------|
| Coordinator | main.js | 3000 (webhook), 9090 (metrics) | Redis, Telegram API, POW Service |
| Worker | worker.js | 3010 (health) | Redis, POW Service, Proxy |
| POW Service | pow-service.js | 3001 (HTTP) | Redis (optional, for caching) |

## Communication Patterns

### Redis Pub/Sub Channels
- `forward_events` — Worker → Coordinator: forward VALID credential to channel
- `update_events` — Worker → Coordinator: update credential status (INVALID/BLOCKED)
- `worker_heartbeats` — Worker → Coordinator: liveness signal

### Redis Data Structures
- `queue:tasks` (LIST) — Main FIFO job queue
- `queue:retry` (LIST) — Priority retry queue
- `result:{status}:{email}:{password}` (STRING, 30d TTL) — Deduplication cache
- `progress:{batchId}` (STRING, 7d TTL) — Batch progress metadata JSON
- `progress:{batchId}:count` (STRING, 7d TTL) — Completed counter
- `progress:{batchId}:counts` (HASH, 7d TTL) — VALID/INVALID/BLOCKED/ERROR counts
- `progress:{batchId}:valid` (LIST, 7d TTL) — Valid credentials list
- `job:{batchId}:{taskId}` (STRING, 5min TTL) — Task lease
- `coordinator:heartbeat` (STRING, 30s TTL) — Coordinator liveness
- `coordinator:lock:{operation}` (STRING, 10s TTL) — Distributed lock
- `worker:{workerId}:heartbeat` (STRING, 30s TTL) — Worker liveness
- `forward:pending:{trackingCode}` (STRING, 2min TTL) — Two-phase commit state
- `msg:{trackingCode}` (STRING, 30d TTL) — Channel message reference
- `msg:cred:{email}:{password}` (STRING, 30d TTL) — Reverse lookup for updates
- `proxy:{proxyId}:health` (STRING, 5min TTL for unhealthy) — Proxy health state
- `pow:{mask}:{key}:{seed}` (STRING, 5min TTL) — POW cache

### Worker Task Processing Loop
1. BLPOP from `queue:retry` (priority) then `queue:tasks`
2. Acquire task lease: SET `job:{batchId}:{taskId}` with NX+EX (5min TTL)
3. Process credential via HTTP flow
4. Store result: SETEX `result:{status}:{email}:{password}` (30d TTL)
5. HINCRBY on `progress:{batchId}:counts`
6. Publish forward/update events via pub/sub
7. Release lease on completion

## External Integrations

1. **Telegram Bot API** (Telegraf v4.16.3) — Primary user interface
2. **Rakuten OAuth/Login Flow** — Target system for credential validation
3. **Rakuten Ichiba API** — Data capture (points, rank, cash)
4. **Rakuten Profile API** — Profile, address, card data
5. **IP Detection Services** — ipify, ipapi, ip-api (for proxy validation)
6. **Redis** (ioredis v5.8.2) — Coordination backbone
7. **POW Service** (internal) — MurmurHash3 challenge computation

## Failure Points and Operational Assumptions

1. **Redis is the single point of failure** — If Redis goes down, the entire coordination layer fails. The current fallback is single-node mode (deprecated).
2. **Telegram 429 rate limiting** — Progress updates throttled to 8s intervals to avoid rate limits.
3. **Worker crash recovery** — Zombie task recovery runs every 60s; tasks with expired leases are re-enqueued.
4. **Coordinator failover** — Backup coordinator can take over if primary heartbeat expires (30s TTL, 60s detection).
5. **POW computation** — Local worker pool fallback if POW service unavailable; native C++ bindings on Linux for 10x speedup.
6. **Proxy failures** — Marked unhealthy after 3 consecutive failures, auto-restored on success.
7. **Graceful shutdown** — Waits up to 5 minutes for active batches to complete.

---

# Deprecated Single-Node Findings

## What Single-Node Mode Does

Single-node mode (`shared/compatibility/SingleNodeMode.js`, 424 lines) provides in-memory equivalents when Redis is unavailable:

- **SingleNodeJobQueue**: In-memory task queue with concurrency control (p-limit)
- **Mock coordinator**: submitBatch/cancelBatch/getSystemStatus stubs
- **Mock progress tracker**: initBatch/handleProgressUpdate/sendSummary stubs
- **Mock channel forwarder**: No-op implementation

## Why It Exists

The compatibility layer (`shared/compatibility/`) was designed to allow the bot to run without Redis for small-scale deployments. `GracefulDegradation.js` (481 lines) monitors Redis availability and falls back to single-node mode when Redis is unreachable.

## Files Belonging to Single-Node Mode

| File | Lines | Purpose |
|------|-------|---------|
| `shared/compatibility/SingleNodeMode.js` | 424 | In-memory job queue and mock components |
| `shared/compatibility/GracefulDegradation.js` | 481 | Redis fallback monitoring and degradation |
| `shared/compatibility/index.js` | 467 | Compatibility facade, mode detection, single-node init |
| `telegram/channelForwarder.js` | 281 | Single-node channel forwarder (duplicate of coordinator version) |
| `telegram/batch/batchExecutor.js` (single-node path) | ~50 lines | `runSingleNodeBatch()` inline processing |
| `telegram/combineBatchRunner.js` (single-node path) | ~30 lines | Single-node combine batch execution |

## What to Prevent from Carrying Over

1. **In-memory job queue** — Does not scale, no persistence, no crash recovery
2. **Mock coordinator/progress/forwarder** — Stubs that hide missing functionality
3. **Auto-fallback to single-node** — The rewrite should require Redis, not degrade silently
4. **Dual channel forwarder** — Two implementations with same interface but different backends
5. **`processBatchLegacy()`** — Legacy batch processing path in compatibility layer
6. **`BATCH_CONCURRENCY` as single-node concept** — In coordination mode, concurrency is per-worker (`WORKER_CONCURRENCY`), not per-batch

---

# Tech Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Node.js | ≥20 |
| Bot Framework | Telegraf | ^4.16.3 |
| HTTP Client | axios | ^1.13.2 |
| Cookie Handling | axios-cookiejar-support + tough-cookie | ^6.0.5 / ^6.0.0 |
| HTML Parsing | cheerio | ^1.1.2 |
| Redis Client (primary) | ioredis | ^5.8.2 |
| Redis Client (secondary) | redis | ^5.10.0 |
| Concurrency | p-limit | ^7.2.0 |
| Hashing | murmurhash3js-revisited / murmurhash-native | ^3.0.0 / ^3.5.1 (optional) |
| HTTP Server | Express | ^5.2.1 |
| Security | helmet, cors, compression | ^8.1.0 / ^2.8.5 / ^1.8.1 |
| Proxy | http-proxy-agent, https-proxy-agent | ^7.0.2 / ^7.0.6 |
| User Agents | user-agents | ^1.1.669 |
| Env Loading | dotenv | ^17.2.3 |
| Container | Docker (node:20-alpine) | — |
| Orchestration | Docker Compose | — |
| Deployment | AWS EC2, systemd, Railway | — |

---

# Runtime and Execution Model

## Service Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     COORDINATOR (main.js)                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ Coordinator   │  │JobQueue      │  │Progress      │              │
│  │ (orchestrator) │  │Manager       │  │Tracker        │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ProxyPool     │  │Channel       │  │Metrics        │              │
│  │Manager       │  │Forwarder      │  │Manager/Server │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│                              │                                      │
│                         Redis Pub/Sub                               │
└──────────────────────────────┼──────────────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
        ▼                      ▼                      ▼
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│   Worker 1    │      │   Worker 2   │      │   Worker N   │
│  (worker.js) │      │  (worker.js) │      │  (worker.js) │
└──────────────┘      └──────────────┘      └──────────────┘
```

## Process Lifecycle

- **Coordinator**: Long-running process, manages Telegram bot + job orchestration
- **Worker**: Long-running process, consumes tasks from Redis queue, sends heartbeats
- **POW Service**: Long-running HTTP service, computes MurmurHash3 challenges via worker threads
- **Redis**: Persistent data store (redis_data volume), backbone for all coordination

## Graceful Shutdown

All services handle SIGINT/SIGTERM:
- Coordinator: waits up to 5 min for active batches, flushes write buffer, closes Redis, stops bot
- Worker: stops pulling new tasks, waits for active tasks, releases leases, cleans up Redis keys
- POW Service: closes HTTP server, shuts down worker pool, closes Redis

---

# Docker and Environment Findings

## Docker Compose Services

| Service | Image | Ports | Key Env Vars |
|---------|-------|-------|-------------|
| redis | redis:7-alpine | 6379:6379 | — |
| pow-service | Dockerfile.pow-service | 8080:8080 | NODE_ENV, LOG_LEVEL, PORT=8080, REDIS_URL |
| coordinator | Dockerfile.coordinator | 3000:3000, 9090:9090 | COORDINATOR_MODE=true, REDIS_URL, TELEGRAM_BOT_TOKEN, TARGET_LOGIN_URL |
| worker1/2/3 | Dockerfile.worker | — | WORKER_ID, REDIS_URL, POW_SERVICE_URL, TARGET_LOGIN_URL |

**Network**: `rakuten-network` (bridge, 172.20.0.0/16)
**Volumes**: `redis_data` (persistent)

## Port Convention Drift

| Context | POW Service Port | Notes |
|---------|-----------------|-------|
| Dockerfile.pow-service default | 3001 | Internal container port |
| docker-compose.yml | 8080 | Maps 8080:8080, sets PORT=8080 |
| AGENTS.md | 3001 internal, 8080 host | Correct mapping |
| Health check in Dockerfile | localhost:3001 | Mismatch when PORT=8080 |

**For rewrite**: Standardize on one port convention. Recommend internal 3001, host-mapped 8080.

## Environment Variables (Complete)

### Required for Coordination Mode
- `COORDINATOR_MODE=true` — Enables coordinator mode
- `REDIS_URL` — Redis connection URL (redis:// or rediss://)
- `TELEGRAM_BOT_TOKEN` — Bot token from @BotFather
- `TARGET_LOGIN_URL` — Rakuten OAuth login URL

### Required for Worker
- `REDIS_URL` — Redis connection URL
- `POW_SERVICE_URL` — POW service endpoint (recommended)

### Required for POW Service
- `POW_SERVICE_MODE=true` — Enables POW service mode

### Key Optional Variables (40+ total, see `shared/config/environment.js`)
- `WORKER_CONCURRENCY` (default: 3) — Tasks per worker
- `WORKER_TASK_TIMEOUT` (default: 120000ms) — Task timeout
- `BATCH_MAX_RETRIES` (default: 2) — Max retries per credential
- `METRICS_PORT` (default: 9090) — Prometheus metrics
- `PROXY_POOL` — Comma-separated proxy URLs
- `FORWARD_CHANNEL_ID` — Telegram channel for VALID results
- `ALLOWED_USER_IDS` — Authorized Telegram user IDs
- `BACKUP_COORDINATOR` (default: false) — Standby failover mode

### Hot-Reloadable Config (via ConfigService)
15 variables can be changed at runtime via Telegram `/config` command:
BATCH_CONCURRENCY, BATCH_DELAY_MS, BATCH_HUMAN_DELAY_MS, BATCH_MAX_RETRIES, BATCH_TIMEOUT_MS, TIMEOUT_MS, TARGET_LOGIN_URL, PROXY_SERVER, PROXY_POOL, PROXY_HEALTH_CHECK_INTERVAL, FORWARD_CHANNEL_ID, FORWARD_TTL_MS, PROCESSED_TTL_MS, WORKER_CONCURRENCY, LOG_LEVEL, JSON_LOGGING, ALLOWED_USER_IDS

---

# Dependency Findings

## Production Dependencies

| Package | Purpose | Notes |
|---------|---------|-------|
| axios | HTTP client | Primary, with cookie jar support |
| axios-cookiejar-support | Cookie persistence | Paired with tough-cookie |
| cheerio | HTML parsing | Used in htmlAnalyzer |
| compression | HTTP compression | Express middleware |
| cors | CORS middleware | Express middleware |
| dotenv | Env loading | Standard |
| express | HTTP server | Used for POW service + metrics |
| helmet | Security headers | Express middleware |
| http-proxy-agent | HTTP proxy | Proxy support |
| https-proxy-agent | HTTPS proxy | Proxy support |
| ioredis | Redis client | Primary Redis client |
| murmurhash3js-revisited | Hashing | Pure JS MurmurHash3 |
| p-limit | Concurrency | Promise concurrency limiting |
| redis | Redis client | Secondary client (dual with ioredis) |
| telegraf | Telegram bot | Bot framework |
| tough-cookie | Cookie handling | Cookie jar |
| user-agents | UA generation | Random user agents |

## Optional Dependencies
| Package | Purpose | Notes |
|---------|---------|-------|
| murmurhash-native | Native MurmurHash3 | C++ bindings, ~10x faster on Linux |

## Dependency Issues
1. **Dual Redis clients**: Both `ioredis` and `redis` are used — should standardize on one
2. **Unused deps**: `form-data`, `jest`, `test` (per CLEANUP_REPORT)
3. **Missing dep**: `node-fetch` imported but not declared (replaced with native fetch in cleanup)
4. **Dual HTTP clients**: `axios` and `node-fetch`/native fetch both used

---

# Workspace Structure

```
rakuten/                                    # Workspace root
├── main.js                                 # Coordinator/single-node entry
├── worker.js                               # Worker entry
├── pow-service.js                          # POW service entry
├── httpChecker.js                          # Credential checking logic
├── logger.js                               # Application logger
├── telegramHandler.js                      # Telegram bot setup + commands
├── package.json                            # Dependencies and scripts
├── docker-compose.yml                      # 5-service orchestration
├── Dockerfile.coordinator                  # Coordinator image
├── Dockerfile.worker                       # Worker image
├── Dockerfile.pow-service                  # POW service image
├── .env / .env.example                     # Environment config
├── AI_CONTEXT.md                           # Deep architecture doc
├── AGENTS.md                               # Quick reference playbook
├── CLEANUP_REPORT.md                       # Previous cleanup audit
├── automation/
│   ├── batch/                              # Batch processing utilities
│   │   ├── constants.js                    # Shared constants
│   │   ├── hotmail.js                      # HOTMAIL domain filter
│   │   ├── http.js                         # HTTP redirect utility (unused?)
│   │   ├── parse.js                        # File parsing + type filters
│   │   ├── processedStore.js               # Dedup cache (Redis/JSONL)
│   │   └── ulp.js                           # ULP domain filter
│   ├── batchProcessor.js                   # Re-export facade (thin)
│   └── http/                               # HTTP credential checking
│       ├── capture/                         # Data capture modules
│       │   ├── apiCapture.js               # Points/Cash/Rank API
│       │   ├── htmlCapture.js              # HTML response capture
│       │   ├── orderHistory.js             # Order history capture
│       │   ├── profileData.js              # Profile data capture
│       │   └── ssoFormHandler.js           # SSO form handling
│       ├── fingerprinting/                  # POW computation
│       │   ├── bioGenerator.js             # Behavioral biometrics
│       │   ├── challengeGenerator.js       # cres POW algorithm
│       │   ├── powCache.js                 # POW result cache
│       │   ├── powServiceClient.js         # HTTP POW service client
│       │   ├── powWorker.js                # Worker thread script
│       │   ├── powWorkerPool.js            # Worker thread pool
│       │   └── ratGenerator.js             # RAT fingerprint data
│       ├── htmlAnalyzer.js                # Response outcome detection
│       ├── httpClient.js                   # Axios client + proxy
│       ├── httpDataCapture.js             # Data capture orchestrator
│       ├── httpFlow.js                     # Login flow (navigate→email→password)
│       ├── ipFetcher.js                    # Exit IP detection
│       ├── payloads/                        # Request payload templates
│       ├── proxyRedirectCookieTracker.js   # Proxy cookie handling
│       ├── retryInterceptor.js            # Axios retry logic
│       └── sessionManager.js              # Session lifecycle
├── config/
│   ├── .env.coordinator                    # Coordinator env template
│   ├── .env.example                        # Full env template
│   ├── .env.local                          # Local dev template
│   └── configSchema.js (in shared/config/) # Hot-reloadable config
├── data/
│   └── processed/                          # JSONL dedup fallback storage
├── deployment/
│   ├── .env.*.example                      # Service env templates
│   ├── *.service                           # systemd unit files
│   ├── user-data-*.sh                      # AWS EC2 user-data scripts
│   ├── redis.conf                          # Redis configuration
│   └── DEPLOYMENT.md / QUICKSTART.md       # Deployment docs
├── docs/
│   ├── AWS_SETUP_GUIDE.md                  # Full AWS walkthrough
│   ├── CONFIG_FEATURE_SUMMARY.md
│   ├── ENVIRONMENT_VARIABLES.md
│   ├── POW_SERVICE_INTEGRATION.md
│   ├── QUICK_UPDATE.md
│   └── TESTING_CONFIG.md
├── scripts/
│   ├── cleanup-stuck-batches.js
│   ├── clear-coordinator-heartbeat.js
│   ├── debug/                              # Debug utilities
│   ├── deploy/                             # Deployment scripts
│   ├── maintenance/                         # Redis maintenance scripts
│   ├── migration/                           # Redis migration scripts
│   ├── setup/                               # Windows/Linux setup scripts
│   └── tests/                               # Integration test scripts (23 files)
├── shared/
│   ├── compatibility/                       # DEPRECATED — single-node fallback
│   │   ├── GracefulDegradation.js          # Redis fallback monitoring
│   │   ├── SingleNodeMode.js               # In-memory job queue + mocks
│   │   └── index.js                         # Compatibility facade
│   ├── config/
│   │   ├── configSchema.js                 # 15 hot-reloadable vars
│   │   ├── configService.js                # Redis pub/sub config
│   │   └── environment.js                  # Mode detection + validation
│   ├── coordinator/                         # COORDINATION MODE CORE
│   │   ├── Coordinator.js                  # Main orchestrator (~980 lines)
│   │   ├── JobQueueManager.js              # Task distribution (~657 lines)
│   │   ├── ProgressTracker.js              # Progress monitoring (~906 lines)
│   │   ├── ChannelForwarder.js             # Channel forwarding (~545 lines)
│   │   ├── ProxyPoolManager.js             # Proxy rotation (~347 lines)
│   │   ├── MetricsManager.js               # Metrics collection (~406 lines)
│   │   ├── MetricsServer.js                # Prometheus endpoint (~276 lines)
│   │   └── index.js                         # Barrel export
│   ├── logger/
│   │   └── structured.js                   # Structured JSON logger
│   ├── redis/
│   │   ├── client.js                       # Redis client wrapper (~418 lines)
│   │   └── keys.js                         # Key schema + generators (~282 lines)
│   └── worker/
│       ├── WorkerNode.js                   # Worker implementation (~1464 lines)
│       └── index.js                         # Barrel export
├── telegram/
│   ├── batch/                              # Batch processing handlers
│   │   ├── batchExecutor.js               # Batch execution + progress/retries
│   │   ├── batchState.js                  # Active/pending batch state
│   │   ├── circuitBreaker.js              # Auto-pause at 60% error threshold
│   │   ├── documentHandler.js             # File upload, inline keyboard
│   │   ├── filterUtils.js                 # Credential dedup filtering
│   │   ├── handlers/                      # Type-specific handlers (hotmail, ulp, jp, all)
│   │   └── index.js                        # registerBatchHandlers
│   ├── batchHandlers.js                   # Facade → telegram/batch/
│   ├── channelForwarder.js                # DEPRECATED — single-node forwarder
│   ├── channelForwardStore.js             # Forward dedupe (Redis/JSONL)
│   ├── combineBatchRunner.js              # Combine batch execution
│   ├── combineHandler.js                  # /combine → /done flow
│   ├── configHandler.js                   # /config via Redis config service
│   ├── exportHandler.js                   # /export VALID from Redis
│   ├── messageTracker.js                  # Forwarded message tracking
│   ├── messages/                          # MarkdownV2 message builders
│   │   ├── helpers.js                     # escapeV2, codeV2, boldV2, spoilerCodeV2
│   │   ├── batchMessages.js
│   │   ├── captureMessages.js
│   │   ├── checkMessages.js
│   │   ├── static.js
│   │   └── index.js
│   └── statusHandler.js                   # /status (system health)
├── tools/
│   └── rakuten-manager/                   # Go CLI for remote management
│       ├── main.go, config.go, operations.go, ssh.go
│       └── rakuten-manager.exe
└── utils/
    ├── mapWithTtl.js                       # TTL map utility
    └── retryWithBackoff.js                 # Generic retry with backoff
```

---

# Entry Points and Boot Flow

| Entry Point | File | Mode | Required Env |
|-------------|------|------|-------------|
| Coordinator | main.js | COORDINATOR_MODE=true | REDIS_URL, TELEGRAM_BOT_TOKEN, TARGET_LOGIN_URL |
| Worker | worker.js | (auto) | REDIS_URL |
| POW Service | pow-service.js | POW_SERVICE_MODE=true | (none required) |
| Single-node (DEPRECATED) | main.js | (no COORDINATOR_MODE, no REDIS_URL) | TELEGRAM_BOT_TOKEN, TARGET_LOGIN_URL |

---

# Core Modules and Responsibilities

## Coordinator Mode Modules

| Module | File | Responsibility |
|--------|------|---------------|
| Coordinator | `shared/coordinator/Coordinator.js` | Main orchestrator: job queue, progress, forwarding, worker monitoring, crash recovery |
| JobQueueManager | `shared/coordinator/JobQueueManager.js` | Task enqueue/dedup/retry, Redis queue management |
| ProgressTracker | `shared/coordinator/ProgressTracker.js` | Batch progress tracking, throttled Telegram updates, summaries |
| ChannelForwarder | `shared/coordinator/ChannelForwarder.js` | Two-phase commit forwarding, status updates (INVALID/BLOCKED) |
| ProxyPoolManager | `shared/coordinator/ProxyPoolManager.js` | Round-robin proxy assignment, health tracking |
| MetricsManager | `shared/coordinator/MetricsManager.js` | Prometheus metrics collection |
| MetricsServer | `shared/coordinator/MetricsServer.js` | HTTP /metrics and /health endpoints |
| WorkerNode | `shared/worker/WorkerNode.js` | Task dequeue, lease management, heartbeat, result storage |
| ConfigService | `shared/config/configService.js` | Redis pub/sub hot-reloadable config |
| Environment | `shared/config/environment.js` | Mode detection, env validation |
| ConfigSchema | `shared/config/configSchema.js` | 15 hot-reloadable variable definitions |
| Redis Client | `shared/redis/client.js` | Singleton Redis connection with retry |
| Redis Keys | `shared/redis/keys.js` | Centralized key schema, TTLs, generators |

## HTTP Checking Modules

| Module | File | Responsibility |
|--------|------|---------------|
| httpFlow | `automation/http/httpFlow.js` | Login flow: navigate → email → password → detect outcome |
| httpClient | `automation/http/httpClient.js` | Axios client with proxy, cookie jar, retry |
| sessionManager | `automation/http/sessionManager.js` | Session lifecycle management |
| htmlAnalyzer | `automation/http/htmlAnalyzer.js` | Response outcome detection (VALID/INVALID/BLOCKED/ERROR) |
| challengeGenerator | `automation/http/fingerprinting/challengeGenerator.js` | POW cres computation |
| powServiceClient | `automation/http/fingerprinting/powServiceClient.js` | HTTP client for remote POW service |
| powWorkerPool | `automation/http/fingerprinting/powWorkerPool.js` | Local worker thread pool for POW |
| apiCapture | `automation/http/capture/apiCapture.js` | Points, Cash, Rank API capture |
| profileData | `automation/http/capture/profileData.js` | Profile data capture |
| orderHistory | `automation/http/capture/orderHistory.js` | Order history capture |
| ssoFormHandler | `automation/http/capture/ssoFormHandler.js` | SSO form extraction |

## Telegram Modules

| Module | File | Responsibility |
|--------|------|---------------|
| telegramHandler | `telegramHandler.js` | Bot setup, command registration, callback routing |
| batchHandlers | `telegram/batchHandlers.js` | Facade → telegram/batch/ |
| batchExecutor | `telegram/batch/batchExecutor.js` | Batch execution logic (single + distributed paths) |
| circuitBreaker | `telegram/batch/circuitBreaker.js` | Error rate monitoring, auto-pause |
| documentHandler | `telegram/batch/documentHandler.js` | File upload, type selection keyboard |
| combineHandler | `telegram/combineHandler.js` | Multi-file upload and merge workflow |
| combineBatchRunner | `telegram/combineBatchRunner.js` | Combine batch execution |
| configHandler | `telegram/configHandler.js` | /config command (hot-reload) |
| exportHandler | `telegram/exportHandler.js` | /export VALID credentials |
| statusHandler | `telegram/statusHandler.js` | /status system health |
| messages | `telegram/messages/` | MarkdownV2 message builders and helpers |

---

# Feature / Capability Inventory

| Feature | Status | Mode | Notes |
|---------|--------|------|-------|
| Single credential check (.chk) | Active | Both | HTTP login flow with POW |
| Batch file processing | Active | Both | Upload file, filter by type |
| Combine multi-file batch | Active | Both | /combine → upload → /done → type → confirm |
| Credential type filtering | Active | Both | HOTMAIL, ULP, JP, ALL |
| Deduplication (processed) | Active | Both | Redis or JSONL fallback, 30-day TTL |
| Channel forwarding (VALID) | Active | Both | Two-phase commit in coordinator mode |
| Channel status updates | Active | Coordination | INVALID delete, BLOCKED edit |
| Proxy rotation | Active | Coordination | Round-robin with health tracking |
| POW computation | Active | Both | Local worker pool or remote service |
| Hot-reloadable config | Active | Coordination | /config command via Redis pub/sub |
| Progress tracking | Active | Both | Throttled Telegram updates (8s) |
| Circuit breaker | Active | Both | Auto-pause at 60% error rate |
| Crash recovery | Active | Coordination | Resume incomplete batches |
| Worker heartbeat monitoring | Active | Coordination | 30s heartbeat, dead worker detection |
| Zombie task recovery | Active | Coordination | 60s scan for expired leases |
| Coordinator failover | Active | Coordination | Backup coordinator via heartbeat |
| Prometheus metrics | Active | Coordination | /metrics endpoint on port 9090 |
| Data capture | Active | Both | Points, rank, cash, profile, cards, orders |
| Credential masking | Active | Both | Spoiler tags in Telegram |
| Export VALID credentials | Active | Both | /export command |
| System status | Active | Both | /status command |
| ULP URL processing | Active | Both | .ulp <url> command |
| Go management CLI | Active | Standalone | tools/rakuten-manager/ |

---

# Data Flow and Control Flow Findings

## Single Credential Check Flow

```
User → .chk user:pass
  → telegramHandler parses input
  → httpChecker.checkCredentials()
    → httpFlow.run()
      → navigate (GET login page)
      → email step (POST email + POW cres)
      → password step (POST password + POW cres)
      → htmlAnalyzer.detectOutcome()
    → On VALID:
      → captureAccountData()
      → buildCheckAndCaptureResult()
      → channelForwarder.forwardValidToChannel()
  → Telegram response with result
```

## Distributed Batch Flow

```
User → Upload file → Select type → Confirm
  → batchExecutor.runDistributedBatch()
    → coordinator.jobQueue.enqueueBatch()
      → checkCachedResults() (MGET dedup)
      → filter out already-processed
      → bulkEnqueueTasks() (pipeline, chunks of 1000)
      → progressTracker.initBatch()
    → progressTracker.startTracking()
      → Poll every 8s
      → Edit Telegram message with progress
      → On completion: sendSummary()

Worker:
  → BLPOP queue:retry (priority) then queue:tasks
  → Acquire lease (SET NX EX 5min)
  → httpChecker.checkCredentials()
  → Store result (SETEX 30d)
  → HINCRBY progress counts
  → Publish forward/update event
  → Release lease
```

## Channel Forward Flow (Two-Phase Commit)

```
Worker finds VALID credential:
  → Publish forward_events
    → Coordinator receives event
    → SET forward:pending:{trackingCode} (2min TTL)
    → Send message to Telegram channel
    → SET msg:{trackingCode} (30d TTL)
    → SET msg:cred:{email}:{password} (30d TTL)
    → DEL forward:pending:{trackingCode}

Worker finds INVALID/BLOCKED:
  → Publish update_events
    → Coordinator receives event
    → INVALID: Delete Telegram message + cleanup Redis
    → BLOCKED: Edit Telegram message with blocked status
```

---

# External Services and Integrations

## Rakuten OAuth/Login Flow (Target System)

| URL | Purpose |
|-----|---------|
| `https://login.account.rakuten.com` | SSO authorization base |
| `https://login.account.rakuten.com/sso/authorize` | OAuth authorize endpoint |
| `https://login.account.rakuten.com/widget` | Login widget |
| `https://login.account.rakuten.com/util/gc` | POW challenge data (mask, key, seed) |
| `https://member.id.rakuten.co.jp` | Session alignment |
| `https://profile.id.rakuten.co.jp` | Profile gateway/callback/token exchange |
| `https://www.rakuten.co.jp/` | Target home page |
| `https://ichiba-common-web-gateway.rakuten.co.jp/ichiba-common/headerinfo/get/v1` | Points/Cash/Rank API |
| `https://order.my.rakuten.co.jp` | Order history |

**All Rakuten URLs are currently hardcoded** and should be configurable in the rewrite.

## IP Detection Services (Hardcoded Fallbacks)

- `https://api.ipify.org?format=json`
- `https://ipapi.co/json/`
- `https://ip-api.com/json/`

## Telegram Bot API

- Framework: Telegraf v4.16.3
- Commands: /start, /help, /stop, /status, /config, /export, /combine, /done, /cancel
- Inline keyboards for batch type selection
- MarkdownV2 formatting with escapeV2/codeV2/boldV2/spoilerCodeV2 helpers
- Critical pattern: `setTimeout(() => {...}, 0)` for long work in callbacks

---

# Configuration and Environment Variables

See "Docker and Environment Findings" section above for complete env var table.

### Configuration Precedence
1. Redis (via ConfigService, hot-reloadable)
2. Environment variables / .env
3. Schema defaults

### Hot-Reloadable Variables (15)
BATCH_CONCURRENCY, BATCH_DELAY_MS, BATCH_HUMAN_DELAY_MS, BATCH_MAX_RETRIES, BATCH_TIMEOUT_MS, TIMEOUT_MS, TARGET_LOGIN_URL, PROXY_SERVER, PROXY_POOL, PROXY_HEALTH_CHECK_INTERVAL, FORWARD_CHANNEL_ID, FORWARD_TTL_MS, PROCESSED_TTL_MS, WORKER_CONCURRENCY, LOG_LEVEL, JSON_LOGGING, ALLOWED_USER_IDS

---

# Scripts / Commands / Automation

| Script | Purpose |
|--------|---------|
| `npm start` / `npm run dev` | Start coordinator/single-node |
| `npm run start:pow-service` | Start POW service |
| `npm run test:integration` | Run all integration tests |
| `npm run test:e2e-batch` | End-to-end batch test |
| `npm run test:coordinator-failover` | Coordinator failover test |
| `npm run test:worker-crash` | Worker crash recovery test |
| `npm run update` | Deploy update via scripts |
| `npm run update:coordinator` | Deploy coordinator update |
| `npm run update:worker` | Deploy worker update |
| `npm run update:pow` | Deploy POW service update |
| `scripts/deploy/quick-update.sh` | Fast deploy (docker cp + restart) |
| `scripts/maintenance/*.js` | Redis maintenance utilities |
| `scripts/migration/*.js` | Redis migration scripts |
| `scripts/debug/*.js` | Debug utilities |
| `scripts/setup/*.ps1` | Windows setup scripts |
| `tools/rakuten-manager/` | Go CLI for remote management |

---

# Important Files and Directories

### Critical for Rewrite (Coordination Mode)
- `shared/coordinator/Coordinator.js` — Core orchestrator
- `shared/coordinator/JobQueueManager.js` — Task distribution
- `shared/coordinator/ProgressTracker.js` — Progress tracking
- `shared/coordinator/ChannelForwarder.js` — Channel forwarding
- `shared/coordinator/ProxyPoolManager.js` — Proxy management
- `shared/worker/WorkerNode.js` — Worker implementation
- `shared/redis/keys.js` — Redis key schema (MUST preserve)
- `shared/redis/client.js` — Redis client wrapper
- `shared/config/configSchema.js` — Hot-reloadable config definitions
- `shared/config/environment.js` — Mode detection and validation
- `automation/http/httpFlow.js` — Login flow logic
- `automation/http/fingerprinting/challengeGenerator.js` — POW algorithm
- `automation/http/capture/*.js` — Data capture modules
- `telegram/messages/helpers.js` — MarkdownV2 formatting

### Critical for Understanding (Deprecated)
- `shared/compatibility/SingleNodeMode.js` — In-memory fallback
- `shared/compatibility/GracefulDegradation.js` — Degradation logic
- `shared/compatibility/index.js` — Mode detection facade
- `telegram/channelForwarder.js` — Single-node forwarder

---

# Suspected Dead Code

| File/Module | Evidence | Confidence |
|-------------|----------|------------|
| `shared/compatibility/SingleNodeMode.js` | Entire file is deprecated single-node fallback | High |
| `shared/compatibility/GracefulDegradation.js` | Redis fallback to single-node mode | High |
| `shared/compatibility/index.js` | Compatibility facade for deprecated mode | High |
| `telegram/channelForwarder.js` | Duplicate of coordinator ChannelForwarder | High |
| `automation/batch/http.js` | `getWithRedirect()` not imported anywhere | Medium |
| `automation/batchProcessor.js` | Thin re-export facade, could import directly | Medium |
| `shared/coordinator/*.test.js` | Jest-style tests but no Jest runner configured | High |
| `shared/worker/WorkerNode.test.js` | Same as above | High |
| `scripts/migration/*.js` | Migration scripts likely completed | Medium |
| `scripts/setup/*.ps1` | Multiple overlapping Windows setup scripts | Medium |
| `tools/` (empty or Go CLI) | Go CLI is separate project | Low |
| `utils/mapWithTtl.js` | TTL map utility, unclear if used | Low |

---

# Duplicate / Conflicting Implementations

| Duplication | Files | Notes |
|-------------|-------|-------|
| Channel Forwarder | `telegram/channelForwarder.js` vs `shared/coordinator/ChannelForwarder.js` | Same interface, different backends (in-memory vs Redis pub/sub) |
| Redis Client | `ioredis` vs `redis` packages | Both used in codebase, should standardize |
| HTTP Client | `axios` vs native `fetch` | Both used, axios is primary |
| Mode Detection | `shared/config/environment.js` vs `shared/compatibility/index.js` | Two separate mode detection implementations |
| Processed Store | `automation/batch/processedStore.js` has own `getRedisClient` | Should use shared Redis client |
| Batch Execution | `telegram/batch/batchExecutor.js` has both `runSingleNodeBatch` and `runDistributedBatch` | Dual paths should be unified |

---

# Risks, Unknowns, and Fragile Areas

## High Risk

1. **Redis is SPOF** — No Redis cluster/replication configured; if Redis goes down, entire coordination fails
2. **Live secrets in .env** — Telegram bot token, Redis password, internal URLs committed to workspace
3. **Hardcoded Rakuten URLs** — Login flow, profile, API endpoints all hardcoded in source
4. **Dual Redis client libraries** — `ioredis` and `redis` both used; potential for inconsistent behavior
5. **Port convention drift** — POW service port 3001 vs 8080 mismatch across Docker/docs/code

## Medium Risk

6. **Empty catch blocks** — Multiple silent error swallows in runtime paths (httpFlow, httpClient, batchExecutor, etc.)
7. **No unit test runner** — 23 integration test scripts but no Jest/Mocha configuration
8. **Circuit breaker thresholds hardcoded** — 60% error rate, 5-result window, 3s pause
9. **Telegram rate limiting** — 8s throttle is empirical, not based on Telegram API limits
10. **JSONL fallback** — When Redis unavailable, falls back to file-based dedup (single-node only)

## Low Risk / Unknown

11. **Go management CLI** — Separate project in `tools/rakuten-manager/`, unclear maintenance status
12. **Railway deployment** — `railway.json` exists but deployment focus is AWS EC2
13. **SSH keys in workspace** — `rakuten-key.pem`, `rakuten.pem`, `rakuten.pub` present
14. **Debug ingest endpoint** — Hardcoded `127.0.0.1:7882` in httpFlow.js (now env-gated)
15. **`PROXY_PASSWORD_ONLY`** — Feature to only proxy the password step, unclear usage

---

# What Must Be Preserved for the Rewrite

1. **Redis key schema** (`shared/redis/keys.js`) — All key patterns, TTLs, generators, and pub/sub channel names
2. **Coordinator orchestration logic** — Job queue management, progress tracking, channel forwarding, proxy rotation, crash recovery, zombie task recovery
3. **Worker task processing loop** — Dequeue, lease, process, store result, publish events, release lease
4. **Two-phase commit for channel forwarding** — Pending state → send → confirm → cleanup
5. **POW challenge computation** — MurmurHash3 cres algorithm, worker pool, caching
6. **HTTP login flow** — Navigate → email → password → detect outcome → capture data
7. **Credential deduplication** — Result cache with 30-day TTL, MGET batch lookups
8. **Hot-reloadable config** — ConfigService with Redis pub/sub propagation
9. **Telegram MarkdownV2 formatting** — escapeV2, codeV2, boldV2, spoilerCodeV2 helpers
10. **Batch type filtering** — HOTMAIL, ULP, JP, ALL credential type filters
11. **Circuit breaker pattern** — Error rate monitoring with auto-pause
12. **Distributed locking** — Redis SETNX with Lua scripts for safe release
13. **Graceful shutdown** — Wait for active tasks, flush buffers, close connections
14. **Proxy rotation with health tracking** — Round-robin, 3-strike unhealthy, auto-restore
15. **Worker heartbeat and dead worker detection** — 30s heartbeat, 30s detection threshold
16. **Config validation schema** — Type, range, and format validation for all env vars
17. **Data capture requirements** — Points, rank, cash, profile, cards, order history
18. **Telegram bot UX patterns** — Command structure, inline keyboards, progress updates, summaries

---

# What Must Be Dropped from the Rewrite

1. **Single-node mode** — Entire `shared/compatibility/` directory (SingleNodeMode.js, GracefulDegradation.js, index.js)
2. **Single-node channel forwarder** — `telegram/channelForwarder.js` (duplicate of coordinator version)
3. **Single-node batch execution path** — `runSingleNodeBatch()` in batchExecutor.js
4. **Single-node combine batch path** — Single-node path in combineBatchRunner.js
5. **Auto-fallback to single-node** — GracefulDegradation Redis fallback logic
6. **JSONL file-based dedup** — `data/processed/` directory and JSONL fallback in processedStore.js
7. **Dual Redis client libraries** — Standardize on one (recommend ioredis)
8. **Unused npm dependencies** — `form-data`, `jest`, `test`
9. **Stale migration scripts** — `scripts/migration/` (likely completed)
10. **Overlapping setup scripts** — `scripts/setup/` (8 files for same purpose)
11. **Unused barrel exports** — `shared/coordinator/index.js`, `shared/worker/index.js` (thin re-exports)
12. **`automation/batchProcessor.js`** — Thin re-export facade
13. **`automation/batch/http.js`** — Unused `getWithRedirect()` function
14. **`.test.js` files without runner** — Jest-style tests with no Jest configuration
15. **`railway.json`** — Railway-specific deployment config (AWS is primary)
16. **SSH keys in workspace** — `rakuten-key.pem`, `rakuten.pem`, `rakuten2.pem`, `rakuten.pub`
17. **`debug-connection.ps1`** — One-off debug script
18. **Dual mode detection** — Two separate implementations in environment.js and compatibility/index.js

---

# What Needs Manual Clarification

1. **Go management CLI** (`tools/rakuten-manager/`) — Is this actively used? Should it be preserved or rewritten?
2. **Railway deployment** — Is Railway still a deployment target or is AWS EC2 the only target?
3. **`PROXY_PASSWORD_ONLY`** — Is this feature actively used? What's the use case?
4. **`AGENT_DEBUG_INGEST_URL`** — Is the debug telemetry endpoint still needed?
5. **`BACKUP_COORDINATOR`** — Is coordinator failover actually used in production?
6. **`NEW_REDIS_URL` / `OLD_REDIS_URL`** — Are these migration vars still needed?
7. **`tools/` directory** — Should this be a separate project or integrated?
8. **`data/processed/` JSONL files** — Are there existing JSONL dedup files that need migration to Redis?
9. **POW service port** — Should the standard be 3001 (internal) or 8080 (Docker)?
10. **Test infrastructure** — Should the rewrite use Jest, Vitest, or another framework? The 23 integration test scripts need a proper runner.
11. **`murmurhash-native`** — Is the C++ native binding still needed or is the pure JS version sufficient?
12. **`redis` vs `ioredis`** — Which should be the standard? Both are currently used.

---

# Appendix: Evidence by File Path

| Finding | File Path | Lines | Confidence |
|---------|-----------|-------|------------|
| Mode detection logic | `shared/config/environment.js` | 433-554 | High |
| Single-node fallback | `shared/compatibility/SingleNodeMode.js` | 1-424 | High |
| Graceful degradation | `shared/compatibility/GracefulDegradation.js` | 1-481 | High |
| Compatibility facade | `shared/compatibility/index.js` | 1-467 | High |
| Coordinator orchestrator | `shared/coordinator/Coordinator.js` | 1-980 | High |
| Job queue manager | `shared/coordinator/JobQueueManager.js` | 1-657 | High |
| Progress tracker | `shared/coordinator/ProgressTracker.js` | 1-906 | High |
| Channel forwarder (distributed) | `shared/coordinator/ChannelForwarder.js` | 1-545 | High |
| Channel forwarder (single-node) | `telegram/channelForwarder.js` | 1-281 | High |
| Proxy pool manager | `shared/coordinator/ProxyPoolManager.js` | 1-347 | High |
| Worker implementation | `shared/worker/WorkerNode.js` | 1-1464 | High |
| Redis key schema | `shared/redis/keys.js` | 1-282 | High |
| Redis client wrapper | `shared/redis/client.js` | 1-418 | High |
| Config schema (hot-reload) | `shared/config/configSchema.js` | 1-330 | High |
| Config service | `shared/config/configService.js` | 1-400 | High |
| POW service | `pow-service.js` | 1-581 | High |
| Main entry point | `main.js` | 1-324 | High |
| Worker entry point | `worker.js` | 1-198 | High |
| Telegram handler | `telegramHandler.js` | 1-676 | High |
| HTTP checker | `httpChecker.js` | 1-277 | High |
| Batch executor | `telegram/batch/batchExecutor.js` | ~200 | High |
| Circuit breaker | `telegram/batch/circuitBreaker.js` | ~50 | High |
| Docker compose | `docker-compose.yml` | 1-201 | High |
| Dockerfile coordinator | `Dockerfile.coordinator` | 1-67 | High |
| Dockerfile worker | `Dockerfile.worker` | 1-66 | High |
| Dockerfile POW | `Dockerfile.pow-service` | 1-83 | High |
| Package dependencies | `package.json` | — | High |
| Env templates | `.env.example`, `config/.env.*` | — | High |
| Cleanup audit | `CLEANUP_REPORT.md` | 1-262 | High |
| Architecture doc | `AI_CONTEXT.md` | 1-122 | High |
| Agent playbook | `AGENTS.md` | 1-~80 | High |
| Hardcoded URLs | `automation/http/httpFlow.js`, `automation/http/capture/*.js` | Multiple | High |
| Empty catch blocks | `httpFlow.js`, `httpClient.js`, `batchExecutor.js`, `combineBatchRunner.js`, `telegramHandler.js`, `mapWithTtl.js`, `exportHandler.js` | Multiple | Medium |
| Dual Redis clients | `package.json` (ioredis + redis) | — | High |
| Unused deps | `package.json` (form-data, jest, test) | — | Medium |