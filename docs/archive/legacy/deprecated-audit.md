# Workspace Audit — 2026-06-14

## Project Summary

**Name:** rakuten-telegram-bot  
**Purpose:** Telegram bot for validating Rakuten account credentials via HTTP, with automatic points/rank capture, channel forwarding, batch processing, and horizontal scaling via distributed coordinator/worker architecture.  
**Runtime:** Node.js >= 20  
**Entry Points:** `main.js` (coordinator), `worker.js` (worker), `pow-service.js` (POW microservice)

## Runtime Entrypoints

| Service | Entry File | Dockerfile | Port | Description |
|---------|-----------|------------|------|-------------|
| Coordinator | `main.js` | `Dockerfile.coordinator` | 3000 (webhook), 9090 (metrics) | Telegram bot + job orchestration |
| Worker | `worker.js` | `Dockerfile.worker` | none (outbound only) | Credential checking worker |
| POW Service | `pow-service.js` | `Dockerfile.pow-service` | 3001 (internal), 8080 (mapped) | Proof-of-work computation |

## Discovered Service Modes

1. **Coordinator mode** (`COORDINATOR_MODE=true`): Telegram bot + Redis-based job distribution + progress tracking + channel forwarding
2. **Worker mode** (default with `REDIS_URL`): Connects to Redis, pulls tasks, reports results
3. **POW Service mode** (`POW_SERVICE_MODE=true`): Standalone HTTP service for CPU-intensive POW computation
4. **Single-node mode** (no `REDIS_URL`): DEPRECATED — inline batch processing, JSONL dedup, no Redis

## Coordination Mode Components

### `shared/coordinator/` (10 files)
- `Coordinator.js` — Main orchestrator: starts heartbeats, pub/sub listeners, monitoring
- `JobQueueManager.js` — Redis-based FIFO task queue (enqueue/dequeue/retry/cancel)
- `ProgressTracker.js` — Batch progress tracking with Telegram message updates
- `ProxyPoolManager.js` — Round-robin proxy assignment with health checks
- `ChannelForwarder.js` — Distributed channel forwarding via pub/sub events
- `MetricsManager.js` — Prometheus metrics collection
- `MetricsServer.js` — HTTP metrics endpoint
- `index.js` — Barrel export (unused by imports, candidate for removal)
- `JobQueueManager.test.js` — Unit test
- `ProgressTracker.test.js` — Unit test

### `shared/worker/` (3 files)
- `WorkerNode.js` — Worker execution loop: dequeue, process, heartbeat, report
- `index.js` — Barrel export
- `WorkerNode.test.js` — Unit test

### `shared/redis/` (2 files)
- `client.js` — ioredis wrapper with connection pooling, retry, health monitoring (418 lines)
- `keys.js` — Centralized Redis key schema (282 lines)

### `shared/config/` (3 files)
- `environment.js` — Mode detection + env var validation (582 lines)
- `configService.js` — Centralized config with Redis pub/sub hot-reload
- `configSchema.js` — Schema: 15 hot-reloadable variables with type/range validation

### `shared/logger/` (1 file)
- `structured.js` — Structured JSON logger

## Deprecated Single-Node Components

### `shared/compatibility/` (3 files)
- `index.js` — CompatibilityLayer: detects mode, falls back to single-node when Redis unavailable
- `SingleNodeMode.js` — In-memory job queue, mock coordinator/progressTracker/channelForwarder
- `GracefulDegradation.js` — Service health monitoring, fallback wrappers

### Single-node code paths in mixed files
- `main.js` — Lines 51-63: single-node env validation, lines 140-152: single-node mode logging
- `telegramHandler.js` — Lines 269-323: coordinator vs single-node `/stop` handling
- `telegram/batch/batchExecutor.js` — Checks `isDistributed()` to route between distributed and inline execution
- `telegram/combineBatchRunner.js` — Entire file is single-node combine batch execution
- `telegram/combineHandler.js` — Contains both single-node and distributed paths

## Docker / Deployment Overview

### Dockerfiles
- `Dockerfile.coordinator` — Multi-stage, copies `main.js`, `telegramHandler.js`, `httpChecker.js`, `logger.js`, `shared/`, `telegram/`, `automation/`, `utils/`, `deployment/`
- `Dockerfile.worker` — Multi-stage with native module compilation, copies `worker.js`, `httpChecker.js`, `logger.js`, `shared/`, `automation/`, `utils/`
- `Dockerfile.pow-service` — Multi-stage with dumb-init, copies `pow-service.js`, `logger.js`, `shared/`, `automation/http/fingerprinting/`

### `docker-compose.yml`
- 5 services: redis, pow-service, coordinator, worker1, worker2, worker3
- Redis: `redis:7-alpine` with custom config
- All services on `rakuten-network` bridge (172.20.0.0/16)
- Coordinator depends on redis + pow-service; workers depend on all three

### `deployment/` (15 files)
- Systemd service files: `coordinator.service`, `worker.service`, `pow-service.service`
- EC2 user-data scripts: `user-data-coordinator.sh`, `user-data-worker.sh`, `user-data-pow-service.sh`
- Env examples: `.env.coordinator.example`, `.env.worker.example`, `.env.pow-service.example`
- `redis.conf` — Redis server configuration
- Docs: `README.md`, `QUICKSTART.md`, `DEPLOYMENT.md`

### `railway.json`
- Nixpacks builder, `node main.js` start command, ON_FAILURE restart policy

## Environment Variable Overview

### Required (Coordinator)
- `TELEGRAM_BOT_TOKEN` — Bot token from @BotFather
- `TARGET_LOGIN_URL` — Rakuten OAuth login URL
- `REDIS_URL` — Redis connection URL

### Required (Worker)
- `REDIS_URL` — Redis connection URL

### Optional (Coordinator)
- `FORWARD_CHANNEL_ID` — Channel for VALID credential forwarding
- `ALLOWED_USER_IDS` — Comma-separated Telegram user IDs
- `COORDINATOR_MODE` — Set to `true`
- `METRICS_PORT` — Prometheus metrics port (default: 9090)
- `PROXY_POOL` — Comma-separated proxy URLs
- `BATCH_CONCURRENCY`, `BATCH_MAX_RETRIES`, `BATCH_DELAY_MS`, `BATCH_HUMAN_DELAY_MS`
- `PROCESSED_TTL_MS`, `FORWARD_TTL_MS`

### Optional (Worker)
- `WORKER_ID` — Auto-generated if not set
- `WORKER_CONCURRENCY` — Concurrent tasks (default: 3)
- `WORKER_TASK_TIMEOUT` — Task timeout (default: 120000)
- `WORKER_HEARTBEAT_INTERVAL` — Heartbeat interval (default: 10000)
- `WORKER_QUEUE_TIMEOUT` — Queue pop timeout (default: 30000)
- `POW_SERVICE_URL` — POW service endpoint

### Optional (POW Service)
- `PORT` — HTTP port (default: 3001)
- `POW_NUM_WORKERS` — Worker threads (default: CPU-1)
- `POW_TASK_TIMEOUT` — Computation timeout (default: 30000)
- `REDIS_URL` — For caching (optional)

### Common
- `LOG_LEVEL` — Logging level (default: info)
- `TIMEOUT_MS` — HTTP timeout (default: 60000)
- `PROXY_SERVER` — Single proxy URL (legacy)
- `NODE_ENV` — Environment (default: production)

### Deprecated (Single-Node Only)
- None that are exclusively single-node — the mode is determined by absence of `REDIS_URL`

## Package / Dependency Overview

### Dependencies (15)
| Package | Purpose | Used By |
|---------|---------|---------|
| `axios` | HTTP client | httpClient, powServiceClient, scripts |
| `axios-cookiejar-support` | Cookie jar for axios | sessionManager |
| `cheerio` | HTML parsing | htmlAnalyzer, capture |
| `compression` | Express middleware | pow-service |
| `cors` | Express middleware | pow-service |
| `dotenv` | Env loading | main.js, worker.js, scripts |
| `express` | HTTP server | pow-service, metrics server |
| `helmet` | Security headers | pow-service |
| `http-proxy-agent` | HTTP proxy | httpClient |
| `https-proxy-agent` | HTTPS proxy | httpClient |
| `ioredis` | Redis client | redis/client, processedStore, channelForwardStore |
| `murmurhash3js-revisited` | POW computation | challengeGenerator |
| `p-limit` | Concurrency control | batch processing |
| `redis` | Redis client (secondary) | scripts/tests |
| `telegraf` | Telegram bot | telegramHandler, all handlers |
| `tough-cookie` | Cookie management | sessionManager |
| `user-agents` | User agent generation | httpClient |

### Optional Dependencies (1)
| Package | Purpose |
|---------|---------|
| `murmurhash-native` | Native C++ POW (10x faster on Linux) |

### Package Scripts (18)
- `start`, `dev` — `node main.js`
- `start:pow-service` — `node pow-service.js`
- `test:*` (10 scripts) — Integration and deployment tests
- `verify:*` (2 scripts) — Deployment verification
- `update:*` (6 scripts) — Deployment update scripts

## Shared Utility Inventory

### `utils/` (2 files)
- `retryWithBackoff.js` — Generic exponential backoff retry with jitter (KEEP)
- `mapWithTtl.js` — TTL-based in-memory Map with auto-cleanup (KEEP)

### `automation/batch/` (6 files)
- `processedStore.js` — Redis/JSONL dedup cache with 30-day TTL
- `parse.js` — Batch file parsing, type filters (hotmail/ulp/jp/all)
- `constants.js` — Domain lists, size limits
- `hotmail.js` — HOTMAIL batch preparation
- `ulp.js` — ULP batch preparation
- `http.js` — HTTP batch utilities

### `automation/http/` (11 files + subdirs)
- `httpFlow.js` — Login flow (navigate → email → password)
- `httpClient.js` — Axios client with cookie jar, proxy support
- `sessionManager.js` — Session lifecycle management
- `htmlAnalyzer.js` — Response outcome detection
- `httpDataCapture.js` — Re-export facade → `capture/`
- `ipFetcher.js` — Exit IP detection
- `proxyRedirectCookieTracker.js` — Proxy redirect handling
- `retryInterceptor.js` — HTTP retry logic
- `capture/` — API capture, HTML capture, order history, profile data, SSO handler
- `fingerprinting/` — challengeGenerator, powServiceClient, powWorker, powWorkerPool, powCache, bioGenerator, ratGenerator
- `payloads/` — authorizeRequest, bioPayload, ratPayload

## Dead File Candidates

| File | Reason | Confidence |
|------|--------|------------|
| `automation/http/httpDataCapture.js` | Re-export facade, only delegates to `capture/index.js` | HIGH |
| `telegram/messages.js` | Re-export facade for `./messages/index` | HIGH |
| `telegram/batchHandlers.js` | Re-export facade for `./batch/index` | HIGH |
| `shared/coordinator/index.js` | Barrel export, not imported by runtime code | MEDIUM |
| `shared/compatibility/index.js` | Barrel export (but used by main.js) | LOW |
| `scripts/test-processed-store-performance.js` | Empty file (0 bytes) | HIGH |
| `scripts/setup/fix-coordinator-no-docker.ps1` | Empty file (0 bytes) | HIGH |
| `ssh-logs.bat` | SSH debug utility, gitignored | LOW |
| `debug-connection.ps1` | Debug utility | LOW |

## Dead Code Candidates

| Code | Location | Reason |
|------|----------|--------|
| `SingleNodeJobQueue` class | `shared/compatibility/SingleNodeMode.js` | Entire class is single-node only |
| `SingleNodeMode` class | `shared/compatibility/SingleNodeMode.js` | Mode detection for deprecated mode |
| `processBatchLegacy` method | `shared/compatibility/index.js` | Legacy single-node batch processing |
| `initializeSingleNodeMode` | `shared/compatibility/index.js` | Single-node initialization |
| `initializeSingleNodeFallback` | `shared/compatibility/index.js` | Single-node fallback |
| `isSingleNodeMode()` | `shared/config/environment.js` | Single-node detection |
| Single-node validation path | `main.js:51-63` | Validates for single-node mode |

## Duplicate Logic Candidates

| Logic | Locations | Recommendation |
|-------|-----------|----------------|
| Logger | `logger.js` + `shared/logger/structured.js` | Consolidate into one |
| Redis client | `shared/redis/client.js` (ioredis) + `redis` npm package | Standardize on ioredis |
| Channel forwarding | `telegram/channelForwarder.js` + `shared/coordinator/ChannelForwarder.js` | Keep both (single vs distributed) |
| Forward store | `telegram/channelForwardStore.js` | Shared by both modes, keep |
| Config loading | `main.js` inline + `shared/config/configService.js` | Use configService exclusively |

## Risky or Unclear Files

| File | Risk | Notes |
|------|------|-------|
| `.env` | **SECURITY** | Contains real Telegram token and Redis password — gitignored but present |
| `tools/rakuten-manager/` | **DEAD WEIGHT** | Go CLI tool with hardcoded IPs, separate project, 7 files |
| `config/.env.local` | **SECURITY** | Contains hardcoded tokens, should not be committed |
| `config/.env.coordinator` | **STALE** | Deployment-specific config template |

## What Should Be Rewritten

1. **`main.js`** — Remove single-node paths, simplify to coordinator-only bootstrap
2. **`shared/compatibility/`** — Remove entirely or replace with coordinator-only initialization
3. **`shared/config/environment.js`** — Remove single-node mode detection, simplify to coordinator/worker/pow-service
4. **`telegramHandler.js`** — Remove single-node `/stop` path, simplify to coordinator-only
5. **`telegram/batch/batchExecutor.js`** — Remove `isDistributed()` branching, assume distributed
6. **`telegram/combineBatchRunner.js`** — Rewrite for distributed execution or remove
7. **`telegram/combineHandler.js`** — Remove single-node paths
8. **`telegram/statusHandler.js`** — Remove single-node fallback status

## What Should Be Deleted

1. **`tools/rakuten-manager/`** — Entire Go CLI tool (7 files)
2. **`config/`** — All 4 files (stale deployment configs)
3. **`shared/compatibility/SingleNodeMode.js`** — Deprecated single-node mode
4. **`shared/compatibility/GracefulDegradation.js`** — Single-node fallback wrappers
5. **Empty files**: `scripts/test-processed-store-performance.js`, `scripts/setup/fix-coordinator-no-docker.ps1`
6. **Re-export facades**: `automation/http/httpDataCapture.js`, `telegram/messages.js`, `telegram/batchHandlers.js`
7. **Superseded scripts**: `scripts/maintenance/clear-redis-conflicts.js`, `scripts/setup/fix-coordinator-issue.ps1`
8. **`ssh-logs.bat`**, **`debug-connection.ps1`** — Debug utilities

## What Should Be Migrated

1. **`utils/retryWithBackoff.js`** → `src/shared/utils/retryWithBackoff.js`
2. **`utils/mapWithTtl.js`** → `src/shared/utils/mapWithTtl.js`
3. **`logger.js`** → `src/shared/logger/index.js` (consolidate with `shared/logger/structured.js`)
4. **`shared/redis/`** → `src/shared/redis/`
5. **`shared/config/`** → `src/shared/config/`
6. **`shared/coordinator/`** → `src/coordinator/`
7. **`shared/worker/`** → `src/worker/`
8. **`automation/http/`** → `src/shared/http/` (mode-agnostic HTTP logic)
9. **`automation/batch/`** → `src/shared/batch/` or `src/coordinator/batch/`
10. **`telegram/`** → `src/telegram/`
11. **`httpChecker.js`** → `src/shared/http/checker.js`
12. **`pow-service.js`** → `src/pow-service/index.js`
13. **`worker.js`** → `src/worker/index.js`
14. **`main.js`** → `src/coordinator/index.js`
