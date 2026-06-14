# Rewrite Foundation — 2026-06-14

## Rewrite Goals

1. **Coordination-mode-only** — Remove all single-node mode code, fallbacks, and detection
2. **Modular architecture** — Clear service boundaries: coordinator, worker, pow-service, shared
3. **Smaller codebase** — Remove dead files, duplicate logic, and deprecated code
4. **Clean entry points** — Each service has one clear entry file under `src/`
5. **Shared modules** — Config, logging, Redis, HTTP, errors, constants extracted into shared
6. **Maintainable** — Clear folder structure, no scattered root-level JS files
7. **Testable** — Structure supports unit tests for shared modules and integration tests per service

## Non-Goals

1. **No new features** — This is a structural rewrite, not a feature add
2. **No dependency upgrades** — Keep current versions unless needed for the rewrite
3. **No new deployment targets** — Keep AWS EC2 + Railway as-is
4. **No API changes** — Telegram commands and batch flows remain the same
5. **No separate project** — This is an in-place rewrite of the current workspace

## In-Place Rewrite Strategy

### Phase 1: Foundation (this document)
- Create audit documents
- Design new folder structure
- Plan cleanup order

### Phase 2: Create New Structure
- Create `src/` directory tree
- Move shared modules first (no service dependencies)
- Move service modules second
- Update imports in each moved file

### Phase 3: Remove Deprecated Code
- Delete single-node mode files
- Delete compatibility layer
- Delete dead files
- Clean up re-export facades

### Phase 4: Update Entry Points
- Rewrite `main.js` → `src/coordinator/index.js`
- Rewrite `worker.js` → `src/worker/index.js`
- Rewrite `pow-service.js` → `src/pow-service/index.js`
- Update root `main.js` to delegate to `src/coordinator/index.js`

### Phase 5: Update Build & Deploy
- Update Dockerfiles to use new paths
- Update `package.json` scripts
- Update `docker-compose.yml`
- Update deployment scripts

### Phase 6: Cleanup
- Remove old root-level JS files
- Remove unused directories
- Remove unused dependencies
- Update documentation

## Coordination-Mode-Only Architecture

### Service Boundaries

```
Coordinator (src/coordinator/)
├── Owns: Telegram bot, job orchestration, progress tracking
├── Depends on: Redis, shared modules
├── Does NOT own: credential checking logic, POW computation
└── Entry: src/coordinator/index.js

Worker (src/worker/)
├── Owns: Task execution, credential checking
├── Depends on: Redis, shared modules, HTTP checker
├── Does NOT own: Telegram bot, job queue management
└── Entry: src/worker/index.js

POW Service (src/pow-service/)
├── Owns: POW computation, caching
├── Depends on: Redis (optional), shared modules
├── Does NOT own: credential checking, Telegram bot
└── Entry: src/pow-service/index.js

Shared (src/shared/)
├── Config: environment validation, config service, schema
├── Logger: structured logging
├── Redis: client, keys
├── HTTP: client, session manager, flow, analyzer
├── Batch: parsing, processed store, constants
├── Fingerprinting: challenge generator, POW client
├── Capture: API capture, HTML capture, profile data
├── Utils: retry, TTL map, error classes
└── Constants: status codes, key prefixes, defaults
```

### Data Flow

```
Telegram → Coordinator → Redis Queue → Worker → HTTP Checker → Rakuten
                                          ↓
                                    POW Service (optional)
                                          ↓
                                    Redis Cache
```

### Redis as Single Source of Truth
- Task queue: `queue:tasks`, `queue:retry`
- Progress: `progress:{batchId}`
- Results: `proc:{user}:{pass}` (processed store)
- Forwards: `fwd:{user}:{pass}` (channel forward dedup)
- Heartbeats: `coordinator:heartbeat`, `worker:{id}:heartbeat`
- Config: `config:{key}` (pub/sub for hot-reload)

## Deprecated Features That Must Not Return

1. **Single-node mode** — No inline batch processing, no JSONL fallback
2. **SingleNodeJobQueue** — In-memory queue is removed
3. **SingleNodeMode class** — Mode detection for deprecated mode is removed
4. **GracefulDegradation** — Fallback wrappers for single-node are removed
5. **CompatibilityLayer** — Mode switching logic is removed
6. **processBatchLegacy** — Legacy batch processing is removed
7. **isSingleNodeMode()** — Detection function is removed
8. **JSONL-based dedup** — Redis-only for processed store
9. **In-memory progress tracking** — Redis-only for progress

## Proposed Service Boundaries

### Coordinator Service
- Telegram bot setup and command handling
- Job queue management (enqueue, cancel, status)
- Progress tracking (init, update, summary)
- Channel forwarding (distributed via pub/sub)
- Proxy pool management
- Metrics collection and HTTP endpoint
- Graceful shutdown with batch completion wait

### Worker Service
- Redis connection and task dequeue
- Credential checking (HTTP flow)
- POW computation (local or via POW service)
- Result storage (processed store)
- Progress reporting
- Heartbeat management
- Graceful shutdown

### POW Service
- HTTP API for POW computation
- Redis caching layer
- Worker thread pool
- Health and metrics endpoints
- Graceful shutdown

### Shared Modules
- **Config**: `environment.js`, `configService.js`, `configSchema.js`
- **Logger**: `logger.js` (consolidated)
- **Redis**: `client.js`, `keys.js`
- **HTTP**: `httpClient.js`, `sessionManager.js`, `httpFlow.js`, `htmlAnalyzer.js`, `ipFetcher.js`
- **Batch**: `parse.js`, `processedStore.js`, `constants.js`
- **Fingerprinting**: `challengeGenerator.js`, `powServiceClient.js`, `powWorkerPool.js`, `powCache.js`
- **Capture**: `apiCapture.js`, `htmlCapture.js`, `orderHistory.js`, `profileData.js`, `ssoFormHandler.js`
- **Utils**: `retryWithBackoff.js`, `mapWithTtl.js`
- **Errors**: Custom error classes (retryable, timeout, validation)
- **Constants**: Status codes, key prefixes, defaults

## Proposed Configuration Strategy

1. **Environment variables** — Primary configuration source
2. **Config service** — Redis-backed hot-reloadable config (15 variables)
3. **Config schema** — Validation, type coercion, defaults
4. **No mode detection** — Each service knows its own mode from its entry point

## Proposed Logging Strategy

1. **Single logger module** — Consolidate `logger.js` and `shared/logger/structured.js`
2. **Scoped loggers** — `createLogger('scope')` pattern (already in use)
3. **Log levels** — error, warn, info, debug, trace
4. **JSON mode** — Optional structured JSON logging for production
5. **No console.log in runtime** — All logging through logger module

## Proposed Error Handling Strategy

1. **Custom error classes** — `RetryableError`, `TimeoutError`, `ValidationError`
2. **Error codes** — Standardized error codes for API responses
3. **No empty catch blocks** — All catches log at debug/warn level
4. **Graceful degradation** — POW service fallback to local computation
5. **Circuit breaker** — Batch processing auto-pause on high error rate

## Proposed Docker Strategy

1. **Three Dockerfiles** — One per service (coordinator, worker, pow-service)
2. **Multi-stage builds** — Builder + production stages
3. **Non-root users** — Security hardening
4. **Health checks** — Each service has a health endpoint
5. **Shared base** — Common Node.js 20 Alpine base
6. **Minimal copies** — Only copy files needed for each service

## Proposed Testing Strategy

1. **Unit tests** — Shared modules (config, logger, redis, utils)
2. **Integration tests** — Per-service (coordinator, worker, pow-service)
3. **E2E tests** — Full coordination flow (coordinator + worker + redis)
4. **Docker smoke test** — `docker-compose up` + health check verification
5. **No AWS dependency** — All tests run locally with Docker Redis

## Rewrite Phases

### Phase 1: Audit & Plan (CURRENT)
- [x] Deep workspace audit
- [x] Create audit documents
- [x] Design new folder structure
- [x] Plan cleanup order

### Phase 2: Create Structure & Move Shared
- [ ] Create `src/` directory tree
- [ ] Move `shared/redis/` → `src/shared/redis/`
- [ ] Move `shared/config/` → `src/shared/config/`
- [ ] Consolidate logger → `src/shared/logger/`
- [ ] Move `utils/` → `src/shared/utils/`
- [ ] Move `automation/http/` → `src/shared/http/`
- [ ] Move `automation/batch/` → `src/shared/batch/`
- [ ] Update all imports in moved files

### Phase 3: Move Services
- [ ] Move `shared/coordinator/` → `src/coordinator/services/`
- [ ] Move `telegram/` → `src/telegram/`
- [ ] Rewrite `main.js` → `src/coordinator/index.js`
- [ ] Move `shared/worker/` → `src/worker/services/`
- [ ] Rewrite `worker.js` → `src/worker/index.js`
- [ ] Rewrite `pow-service.js` → `src/pow-service/index.js`
- [ ] Move `httpChecker.js` → `src/shared/http/checker.js`

### Phase 4: Remove Deprecated
- [ ] Delete `shared/compatibility/` (entire directory)
- [ ] Delete single-node code paths in mixed files
- [ ] Delete dead files (empty files, re-export facades)
- [ ] Delete `tools/rakuten-manager/` (Go CLI tool)
- [ ] Delete `config/` (stale deployment configs)

### Phase 5: Update Build & Deploy
- [ ] Update Dockerfiles for new paths
- [ ] Update `package.json` scripts
- [ ] Update `docker-compose.yml`
- [ ] Update deployment scripts
- [ ] Update `.dockerignore`

### Phase 6: Final Cleanup
- [ ] Remove old root-level JS files
- [ ] Remove unused dependencies
- [ ] Update documentation
- [ ] Verify all services start correctly

## Cleanup Phases

### Immediate (Phase 4)
- Delete `tools/rakuten-manager/` (7 files)
- Delete `config/` (4 files)
- Delete empty files (2 files)
- Delete re-export facades (3 files)
- Delete superseded scripts (2 files)

### After Migration (Phase 6)
- Delete old root-level JS files (5 files)
- Delete `shared/compatibility/` (3 files)
- Delete `shared/logger/` (1 file, consolidated)
- Delete `automation/http/httpDataCapture.js` (1 file)
- Delete `telegram/messages.js` (1 file)
- Delete `telegram/batchHandlers.js` (1 file)
