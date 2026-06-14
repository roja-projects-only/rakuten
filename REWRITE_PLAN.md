# Rewrite Plan

> **Document purpose**: Planning document for a future clean rewrite of the Rakuten Telegram Credential Checker. This is NOT implementation code — it is conceptual mapping, priorities, and principles only. The rewrite targets coordination mode exclusively.

---

# Rewrite Goals

1. **Coordination-only architecture** — Remove single-node mode entirely; Redis is a hard requirement
2. **Clean service boundaries** — Each service (coordinator, worker, POW) is a separate, independently deployable unit with explicit contracts
3. **Reduced operational complexity** — Fewer env vars, clearer configuration, single Redis client library
4. **Testable modules** — Proper unit and integration test infrastructure from day one
5. **Security by default** — No secrets in code, no hardcoded URLs, proper env validation
6. **Observable by default** — Structured logging, metrics, health checks in every service
7. **Preserve all coordination-mode functionality** — Job queue, progress tracking, channel forwarding, proxy rotation, crash recovery, hot-reloadable config

---

# Rewrite Principles

1. **Redis is required, not optional** — No fallback mode. If Redis is down, the service fails fast with a clear error.
2. **One service, one entry point** — Coordinator, worker, and POW service each have a single `main.js` with no mode detection branching.
3. **No compatibility layer** — No `GracefulDegradation`, no `SingleNodeMode`, no mode-switching facade.
4. **Single Redis client library** — Choose `ioredis` (more feature-rich, used in most of the codebase) and remove `redis` package.
5. **Single channel forwarder** — One implementation using Redis pub/sub, no in-memory fallback.
6. **Configuration is explicit** — Each service validates its required env vars at startup and fails if missing.
7. **All external URLs are configurable** — No hardcoded Rakuten endpoints, IP detection services, or debug URLs.
8. **No silent errors** — Every catch block must log at minimum debug level.
9. **TypeScript or JSDoc** — All public interfaces must have type annotations for IDE support and documentation.
10. **Test infrastructure first** — Set up test runner (Vitest recommended) before writing application code.

---

# Coordination-Only Target Architecture

## Service Topology

```
┌─────────────────────────────────────────────────────────┐
│                    COORDINATOR                           │
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐    │
│  │ Telegram    │  │ Job Queue  │  │ Progress       │    │
│  │ Bot Handler │  │ Manager    │  │ Tracker        │    │
│  └────────────┘  └────────────┘  └────────────────┘    │
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐    │
│  │ Channel    │  │ Proxy Pool │  │ Metrics        │    │
│  │ Forwarder  │  │ Manager    │  │ Server         │    │
│  └────────────┘  └────────────┘  └────────────────┘    │
│  ┌────────────┐  ┌────────────┐                         │
│  │ Config     │  │ Crash      │                         │
│  │ Service    │  │ Recovery   │                         │
│  └────────────┘  └────────────┘                         │
│                          │                               │
│                    Redis Pub/Sub                         │
└──────────────────────────┼───────────────────────────────┘
                           │
    ┌──────────────────────┼──────────────────────┐
    │                      │                      │
    ▼                      ▼                      ▼
┌─────────┐         ┌─────────┐         ┌─────────┐
│ WORKER 1│         │ WORKER 2│         │ WORKER N│
│ ┌─────┐ │         │ ┌─────┐ │         │ ┌─────┐ │
│ │HTTP │ │         │ │HTTP │ │         │ │HTTP │ │
│ │Flow │ │         │ │Flow │ │         │ │Flow │ │
│ └─────┘ │         │ └─────┘ │         │ └─────┘ │
│ ┌─────┐ │         │ ┌─────┐ │         │ ┌─────┐ │
│ │POW  │ │         │ │POW  │ │         │ │POW  │ │
│ │Client│ │         │ │Client│ │         │ │Client│ │
│ └─────┘ │         │ └─────┘ │         │ └─────┘ │
└─────────┘         └─────────┘         └─────────┘
                           │
                    ┌──────┴──────┐
                    │ POW SERVICE │
                    │ ┌─────────┐ │
                    │ │Worker   │ │
                    │ │Pool     │ │
                    │ └─────────┘ │
                    │ ┌─────────┐ │
                    │ │Cache    │ │
                    │ └─────────┘ │
                    └─────────────┘
```

## Service Contracts

### Coordinator Service
- **Entry**: `coordinator.js`
- **Required env**: `REDIS_URL`, `TELEGRAM_BOT_TOKEN`, `TARGET_LOGIN_URL`
- **Ports**: 3000 (Telegram webhook), 9090 (metrics)
- **Responsibilities**: Telegram bot, job queue management, progress tracking, channel forwarding, proxy rotation, crash recovery, metrics
- **Redis usage**: All key patterns from `shared/redis/keys.js`, pub/sub channels

### Worker Service
- **Entry**: `worker.js`
- **Required env**: `REDIS_URL`
- **Recommended env**: `POW_SERVICE_URL`
- **Ports**: 3010 (health)
- **Responsibilities**: Task dequeue, credential checking, result storage, heartbeat, event publishing
- **Redis usage**: Queue consumption, result storage, heartbeat, event publishing

### POW Service
- **Entry**: `pow-service.js`
- **Optional env**: `REDIS_URL` (for caching)
- **Ports**: 3001 (HTTP)
- **Responsibilities**: MurmurHash3 cres computation, result caching
- **Redis usage**: POW cache (optional)

---

# Recommended New Workspace Structure

```
rakuten-v2/
├── packages/
│   ├── coordinator/                  # Coordinator service
│   │   ├── src/
│   │   │   ├── index.js              # Entry point
│   │   │   ├── bot/                  # Telegram bot handlers
│   │   │   │   ├── commands.js       # Command registration
│   │   │   │   ├── callbacks.js      # Inline keyboard callbacks
│   │   │   │   ├── batch/            # Batch processing handlers
│   │   │   │   └── messages/         # MarkdownV2 message builders
│   │   │   ├── coordinator/          # Core coordination logic
│   │   │   │   ├── Coordinator.js
│   │   │   │   ├── JobQueueManager.js
│   │   │   │   ├── ProgressTracker.js
│   │   │   │   ├── ChannelForwarder.js
│   │   │   │   ├── ProxyPoolManager.js
│   │   │   │   └── CrashRecovery.js
│   │   │   └── config.js             # Service-specific config
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── worker/                        # Worker service
│   │   ├── src/
│   │   │   ├── index.js              # Entry point
│   │   │   ├── WorkerNode.js
│   │   │   ├── checker/              # HTTP credential checking
│   │   │   │   ├── httpFlow.js
│   │   │   │   ├── httpClient.js
│   │   │   │   ├── htmlAnalyzer.js
│   │   │   │   ├── sessionManager.js
│   │   │   │   ├── capture/          # Data capture modules
│   │   │   │   └── fingerprinting/   # POW computation
│   │   │   └── config.js
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── pow-service/                   # POW computation service
│   │   ├── src/
│   │   │   ├── index.js
│   │   │   ├── POWService.js
│   │   │   ├── challengeGenerator.js
│   │   │   ├── powWorker.js
│   │   │   └── powWorkerPool.js
│   │   ├── Dockerfile
│   │   └── package.json
│   └── shared/                        # Shared library
│       ├── src/
│       │   ├── redis/
│       │   │   ├── client.js          # Redis connection
│       │   │   └── keys.js           # Key schema
│       │   ├── config/
│       │   │   ├── schema.js         # Config definitions
│       │   │   └── service.js        # Config service (Redis pub/sub)
│       │   ├── logger/
│       │   │   └── structured.js
│       │   ├── utils/
│       │   │   ├── retryWithBackoff.js
│       │   │   └── mapWithTtl.js
│       │   └── types/                # Shared type definitions
│       └── package.json
├── docker-compose.yml
├── .env.example
├── package.json                       # Workspace root (monorepo)
└── README.md
```

**Key structural decisions**:
- **Monorepo with packages/** — Each service is independently deployable but shares code via the `shared` package
- **No compatibility layer** — No `shared/compatibility/` directory
- **No single-node path** — No mode detection, no fallback
- **Checker logic in worker** — The HTTP credential checking flow belongs in the worker package, not shared
- **Shared package for cross-cutting concerns** — Redis client, key schema, config, logger, utils

---

# Module Boundaries for the New Rewrite

## Coordinator Package

| Module | Responsibility | Dependencies |
|--------|---------------|-------------|
| `Coordinator` | Orchestration, startup, shutdown, crash recovery | All coordinator modules |
| `JobQueueManager` | Task enqueue, dedup, retry, cancel | Redis, ConfigService |
| `ProgressTracker` | Batch progress, throttled Telegram updates | Redis, Telegram bot |
| `ChannelForwarder` | Two-phase commit forwarding, status updates | Redis, Telegram bot |
| `ProxyPoolManager` | Proxy rotation, health tracking | Redis |
| `CrashRecovery` | Resume incomplete batches, retry pending forwards | Redis, JobQueueManager |
| `MetricsServer` | Prometheus /metrics and /health endpoints | Coordinator |
| `Bot/Commands` | Telegram command handlers | Coordinator, Telegram bot |
| `Bot/Messages` | MarkdownV2 message builders | None (pure formatting) |

## Worker Package

| Module | Responsibility | Dependencies |
|--------|---------------|-------------|
| `WorkerNode` | Task dequeue, lease management, heartbeat, result storage | Redis |
| `HttpFlow` | Login flow: navigate → email → password → detect outcome | httpClient, fingerprinting |
| `HttpClient` | Axios client with proxy, cookie jar, retry | Proxy config |
| `HtmlAnalyzer` | Response outcome detection | cheerio |
| `SessionManager` | Session lifecycle | httpClient |
| `Capture/*` | Data capture (points, rank, profile, orders) | httpClient |
| `Fingerprinting/*` | POW challenge computation | powServiceClient or local pool |

## POW Service Package

| Module | Responsibility | Dependencies |
|--------|---------------|-------------|
| `POWService` | HTTP server, /compute endpoint, /health, /metrics | Express |
| `ChallengeGenerator` | MurmurHash3 cres computation | murmurhash3js-revisited |
| `PowWorkerPool` | Worker thread pool management | worker_threads |
| `PowCache` | Redis-based result caching | Redis (optional) |

## Shared Package

| Module | Responsibility | Dependencies |
|--------|---------------|-------------|
| `redis/client` | Singleton Redis connection with retry | ioredis |
| `redis/keys` | Key schema, TTLs, generators, pub/sub channels | None |
| `config/schema` | Config variable definitions with validation | None |
| `config/service` | Hot-reloadable config via Redis pub/sub | Redis |
| `logger/structured` | Structured JSON logging | None |
| `utils/retryWithBackoff` | Generic retry utility | None |
| `utils/mapWithTtl` | TTL map utility | None |

---

# Migration Priorities

## Priority 1: Core Infrastructure (Week 1-2)
1. Redis client and key schema
2. Config service and schema
3. Structured logger
4. Environment validation per service
5. Docker Compose with Redis

## Priority 2: Worker Service (Week 2-3)
1. Worker entry point and task loop
2. HTTP credential checking flow
3. POW computation (local + remote)
4. Result storage and event publishing
5. Heartbeat and lease management

## Priority 3: Coordinator Service (Week 3-5)
1. Coordinator entry point and startup
2. Job queue manager
3. Progress tracker
4. Channel forwarder
5. Proxy pool manager
6. Crash recovery
7. Telegram bot handlers

## Priority 4: POW Service (Week 5-6)
1. POW service entry point
2. Challenge computation endpoint
3. Worker thread pool
4. Redis caching (optional)

## Priority 5: Polish and Testing (Week 6-8)
1. Integration tests
2. Metrics and monitoring
3. Deployment scripts
4. Documentation

---

# Step-by-Step Rewrite Sequence

## Step 1: Project Scaffolding
- Initialize monorepo with packages/ structure
- Set up shared package with Redis client, key schema, config, logger
- Create .env.example with all required variables
- Set up Docker Compose with Redis service
- Set up test runner (Vitest)

## Step 2: Shared Infrastructure
- Port `shared/redis/keys.js` — key schema, TTLs, generators, pub/sub channels
- Port `shared/redis/client.js` — singleton Redis connection with retry (ioredis only)
- Port `shared/config/configSchema.js` — config variable definitions
- Port `shared/config/configService.js` — hot-reloadable config via Redis pub/sub
- Port `shared/logger/structured.js` — structured JSON logger
- Port `utils/retryWithBackoff.js` and `utils/mapWithTtl.js`

## Step 3: Worker Service
- Create worker entry point with env validation (REDIS_URL required)
- Port `WorkerNode` task loop: dequeue, lease, process, store, publish, release
- Port HTTP credential checking flow from `automation/http/`
- Port POW computation from `automation/http/fingerprinting/`
- Port data capture modules from `automation/http/capture/`
- Port session management and proxy handling
- Add health check endpoint

## Step 4: Coordinator Service
- Create coordinator entry point with env validation (REDIS_URL, TELEGRAM_BOT_TOKEN, TARGET_LOGIN_URL required)
- Port `Coordinator` orchestrator (startup, shutdown, crash recovery)
- Port `JobQueueManager` (enqueue, dedup, retry, cancel)
- Port `ProgressTracker` (batch tracking, throttled updates, summaries)
- Port `ChannelForwarder` (two-phase commit, status updates)
- Port `ProxyPoolManager` (rotation, health tracking)
- Port `MetricsServer` (Prometheus /metrics, /health)
- Port Telegram bot handlers from `telegram/`

## Step 5: POW Service
- Create POW service entry point
- Port `POWService` HTTP server
- Port `challengeGenerator` (MurmurHash3)
- Port `powWorkerPool` (worker threads)
- Port `powCache` (Redis caching)
- Add /health and /metrics endpoints

## Step 6: Integration and Testing
- Write integration tests for each service
- Test coordinator ↔ worker communication via Redis
- Test crash recovery scenarios
- Test channel forwarding two-phase commit
- Test proxy rotation and health tracking
- Test POW service local and remote modes

## Step 7: Deployment
- Create Dockerfiles for each service
- Create Docker Compose for full stack
- Create deployment documentation
- Create systemd unit files
- Create AWS deployment scripts

---

# Legacy-to-New Mapping

| Legacy Module | New Package | New Module | Notes |
|---------------|-------------|------------|-------|
| `main.js` | coordinator | `src/index.js` | Coordinator-only, no mode detection |
| `worker.js` | worker | `src/index.js` | Worker-only, no mode detection |
| `pow-service.js` | pow-service | `src/index.js` | POW-only, no mode detection |
| `shared/coordinator/Coordinator.js` | coordinator | `src/coordinator/Coordinator.js` | Remove single-node paths |
| `shared/coordinator/JobQueueManager.js` | coordinator | `src/coordinator/JobQueueManager.js` | Preserve as-is |
| `shared/coordinator/ProgressTracker.js` | coordinator | `src/coordinator/ProgressTracker.js` | Preserve as-is |
| `shared/coordinator/ChannelForwarder.js` | coordinator | `src/coordinator/ChannelForwarder.js` | Single implementation only |
| `shared/coordinator/ProxyPoolManager.js` | coordinator | `src/coordinator/ProxyPoolManager.js` | Preserve as-is |
| `shared/coordinator/MetricsManager.js` | coordinator | `src/coordinator/MetricsManager.js` | Preserve as-is |
| `shared/coordinator/MetricsServer.js` | coordinator | `src/coordinator/MetricsServer.js` | Preserve as-is |
| `shared/worker/WorkerNode.js` | worker | `src/WorkerNode.js` | Remove single-node references |
| `shared/redis/client.js` | shared | `src/redis/client.js` | ioredis only, remove redis package |
| `shared/redis/keys.js` | shared | `src/redis/keys.js` | Preserve exactly — critical schema |
| `shared/config/configSchema.js` | shared | `src/config/schema.js` | Preserve, remove single-node vars |
| `shared/config/configService.js` | shared | `src/config/service.js` | Preserve, remove single-node fallback |
| `shared/config/environment.js` | shared | `src/config/environment.js` | Rewrite: per-service validation, no mode detection |
| `shared/logger/structured.js` | shared | `src/logger/structured.js` | Preserve as-is |
| `telegramHandler.js` | coordinator | `src/bot/commands.js` | Remove single-node paths |
| `telegram/batch/` | coordinator | `src/bot/batch/` | Remove single-node batch path |
| `telegram/combineHandler.js` | coordinator | `src/bot/combineHandler.js` | Remove single-node combine path |
| `telegram/messages/` | coordinator | `src/bot/messages/` | Preserve as-is |
| `telegram/channelForwarder.js` | **DROP** | — | Single-node duplicate, replaced by coordinator version |
| `telegram/channelForwardStore.js` | shared | `src/redis/channelForwardStore.js` | Preserve, used by both modes |
| `telegram/configHandler.js` | coordinator | `src/bot/configHandler.js` | Preserve as-is |
| `telegram/exportHandler.js` | coordinator | `src/bot/exportHandler.js` | Preserve as-is |
| `telegram/statusHandler.js` | coordinator | `src/bot/statusHandler.js` | Remove single-node path |
| `automation/http/httpFlow.js` | worker | `src/checker/httpFlow.js` | Preserve, make URLs configurable |
| `automation/http/httpClient.js` | worker | `src/checker/httpClient.js` | Preserve, remove dual client |
| `automation/http/capture/*.js` | worker | `src/checker/capture/` | Preserve, make URLs configurable |
| `automation/http/fingerprinting/` | worker | `src/checker/fingerprinting/` | Preserve |
| `automation/batch/processedStore.js` | shared | `src/redis/processedStore.js` | Remove JSONL fallback |
| `automation/batch/parse.js` | coordinator | `src/bot/batch/parse.js` | Preserve |
| `automation/batch/hotmail.js` | coordinator | `src/bot/batch/hotmail.js` | Preserve |
| `automation/batch/ulp.js` | coordinator | `src/bot/batch/ulp.js` | Preserve |
| `shared/compatibility/*` | **DROP** | — | Entire directory deprecated |
| `httpChecker.js` | worker | `src/checker/index.js` | Preserve, remove single-node path |
| `logger.js` | shared | `src/logger/index.js` | Preserve |

---

# Risk Mitigation Plan

## Risk 1: Redis Key Schema Changes
- **Mitigation**: Port `shared/redis/keys.js` exactly as-is in the first step. Do not modify key patterns, TTLs, or generators until all services are working.
- **Validation**: Integration tests that verify key patterns match expected format.

## Risk 2: POW Algorithm Regression
- **Mitigation**: Port `challengeGenerator.js` and `powWorkerPool.js` with minimal changes. Test against known challenge/response pairs.
- **Validation**: Unit tests with fixed input/output pairs for MurmurHash3 computation.

## Risk 3: Telegram Rate Limiting
- **Mitigation**: Preserve the 8-second throttle on progress updates. Document the Telegram API rate limits in the rewrite.
- **Validation**: Integration test with mock Telegram API that verifies throttle timing.

## Risk 4: Two-Phase Commit for Channel Forwarding
- **Mitigation**: Port the exact two-phase commit logic from `ChannelForwarder.js`. Test crash scenarios where pending forwards exist.
- **Validation**: Integration test that simulates coordinator crash during forward and verifies recovery.

## Risk 5: Worker Task Lease Management
- **Mitigation**: Port the exact lease acquisition (SET NX EX) and release (Lua script) logic. Test zombie task recovery.
- **Validation**: Integration test that simulates worker crash and verifies task re-enqueue.

## Risk 6: Configuration Hot-Reload
- **Mitigation**: Port ConfigService with Redis pub/sub propagation. Test that config changes propagate to all workers.
- **Validation**: Integration test that changes a config value and verifies all services receive the update.

## Risk 7: Hardcoded URLs
- **Mitigation**: Extract all Rakuten URLs into configurable env vars with sensible defaults. Create a URL configuration module.
- **Validation**: Test that changing TARGET_LOGIN_URL and other URL env vars works correctly.

## Risk 8: Dual Redis Client Library
- **Mitigation**: Standardize on `ioredis`. Audit all `redis` package usage and replace with `ioredis` equivalents.
- **Validation**: Search codebase for `require('redis')` and verify zero occurrences.

---

# Documentation To Create First

1. **Service Contract Specification** — Define the exact Redis key patterns, pub/sub channels, and message formats that services use to communicate. This is the API between services.

2. **Environment Variable Reference** — Per-service env var documentation with required/optional, defaults, and validation rules. No single-node vars.

3. **Redis Key Schema** — Copy `shared/redis/keys.js` documentation exactly. This is the single source of truth for inter-service communication.

4. **Telegram Bot Command Reference** — Document all commands, their expected inputs, and their outputs.

5. **HTTP Login Flow Specification** — Document the exact sequence of HTTP requests, headers, cookies, and responses for the Rakuten login flow.

6. **Deployment Guide** — Docker Compose setup, AWS EC2 deployment, systemd unit files.

---

# Cleanup Rules for the New Workspace

1. **No compatibility layers** — Never create a `compatibility/` directory. If Redis is required, fail fast.
2. **No mode detection** — Each service has one mode. No `COORDINATOR_MODE` flag. The entry point determines the mode.
3. **No duplicate implementations** — One channel forwarder, one Redis client, one HTTP client.
4. **No hardcoded URLs** — All external URLs must be configurable via env vars with sensible defaults.
5. **No silent errors** — Every `catch` block must log at minimum debug level. No empty catch blocks.
6. **No JSONL fallbacks** — Redis is required. No file-based fallback for deduplication.
7. **No barrel re-exports** — Import directly from source files. No `index.js` that just re-exports.
8. **No test files without a runner** — If writing tests, set up the test runner first. No orphan `.test.js` files.
9. **No secrets in code** — All secrets via env vars. `.env` files in `.gitignore`. No hardcoded credentials.
10. **One Redis client library** — `ioredis` only. No `redis` package.
11. **Explicit service boundaries** — Each service validates its own required env vars at startup.
12. **Port conventions are documented** — Internal ports: coordinator 3000, worker 3010, POW 3001, metrics 9090. No ambiguity.
13. **All catch blocks log** — Minimum `log.debug(error)`. No silent swallowing.
14. **Config changes are validated** — Hot-reloadable config must validate new values before applying.
15. **Docker Compose uses profiles** — `docker-compose --profile coordinator up` for targeted deployment.

---

# Suggested Validation and Testing Strategy

## Unit Tests
- Redis key generation and parsing (`keys.js`)
- Config validation (`schema.js`)
- Credential parsing and filtering (`parse.js`, `hotmail.js`, `ulp.js`)
- HTML outcome detection (`htmlAnalyzer.js`)
- POW challenge computation (`challengeGenerator.js`)
- Message formatting (`messages/helpers.js`)

## Integration Tests
- Worker task dequeue → process → store result → publish event
- Coordinator job enqueue → progress tracking → summary
- Channel forward two-phase commit (success and crash scenarios)
- Proxy rotation and health tracking
- Crash recovery (incomplete batch resume)
- Config hot-reload propagation
- Worker heartbeat and dead worker detection

## End-to-End Tests
- Full batch flow: upload → parse → enqueue → process → progress → summary
- Single credential check: .chk → result → forward
- Combine batch flow: /combine → upload → /done → type → confirm → process
- Coordinator failover: primary down → backup takes over

## Test Infrastructure
- Use Vitest as test runner (fast, ESM-native, good TypeScript support)
- Use `ioredis-mock` or testcontainers for Redis in tests
- Use `nock` or `axios-mock-adapter` for HTTP mocking
- Create Telegram bot mock for handler testing

---

# Suggested Docker Strategy

## Principles
- Each service has its own Dockerfile
- Multi-stage builds for minimal image size
- Non-root users for security
- Health checks on all services
- No hardcoded ports in Dockerfiles (use env vars with defaults)

## Docker Compose Structure

```yaml
services:
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    volumes: [redis_data:/data]
    healthcheck: { test: ["CMD", "redis-cli", "ping"] }

  pow-service:
    build: { context: ., dockerfile: Dockerfile.pow-service }
    environment:
      - REDIS_URL=redis://redis:6379
      - PORT=3001
    ports: ["3001:3001"]
    healthcheck: { test: ["CMD", "curl", "-f", "http://localhost:3001/health"] }

  coordinator:
    build: { context: ., dockerfile: Dockerfile.coordinator }
    environment:
      - REDIS_URL=redis://redis:6379
      - POW_SERVICE_URL=http://pow-service:3001
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - TARGET_LOGIN_URL=${TARGET_LOGIN_URL}
    ports: ["3000:3000", "9090:9090"]
    healthcheck: { test: ["CMD", "curl", "-f", "http://localhost:9090/health"] }

  worker:
    build: { context: ., dockerfile: Dockerfile.worker }
    environment:
      - REDIS_URL=redis://redis:6379
      - POW_SERVICE_URL=http://pow-service:3001
    deploy: { replicas: 3 }
```

**Key changes from legacy**:
- Worker uses `deploy: replicas` instead of hardcoded worker1/2/3
- POW service uses consistent port 3001 (no 8080 confusion)
- All health checks use the service's own health endpoint
- No `COORDINATOR_MODE` env var — the Dockerfile IS the mode

---

# Open Decisions Requiring Owner Input

1. **TypeScript vs JavaScript** — Should the rewrite use TypeScript for type safety, or stay with JavaScript + JSDoc? TypeScript adds build complexity but improves maintainability.

2. **Monorepo tooling** — Should the rewrite use npm workspaces, pnpm workspaces, Turborepo, or another monorepo tool? npm workspaces is simplest.

3. **Test framework** — Vitest (recommended for speed and ESM support) vs Jest (more established) vs Mocha?

4. **Go management CLI** — Should `tools/rakuten-manager/` be preserved, rewritten, or dropped? It's a separate Go project.

5. **Railway deployment** — Is Railway still a deployment target, or is AWS EC2 the only target?

6. **POW service port** — Should the standard be 3001 (internal) or 8080 (Docker host)? Recommend 3001 internal, 8080 host-mapped.

7. **`murmurhash-native`** — Is the C++ native binding still needed for 10x speedup, or is the pure JS version sufficient?

8. **`PROXY_PASSWORD_ONLY`** — Is this feature actively used? Should it be preserved in the rewrite?

9. **Debug telemetry** — Is the `AGENT_DEBUG_INGEST_URL` feature still needed?

10. **Backup coordinator** — Is the `BACKUP_COORDINATOR` failover feature actually used in production? It adds complexity.

11. **JSONL dedup migration** — Are there existing JSONL dedup files in `data/processed/` that need to be migrated to Redis?

12. **`redis` vs `ioredis`** — Confirm standardization on `ioredis`. The `redis` package is used in some places (e.g., `processedStore.js`).

13. **Config hot-reload scope** — Should all 15 hot-reloadable vars be preserved, or should some be startup-only?

14. **Worker count** — Should Docker Compose default to 3 workers, or should this be configurable via `deploy.replicas`?

15. **Telegram bot mode** — Should the rewrite use long polling (current) or webhooks? Webhooks are more production-ready but require a public URL.