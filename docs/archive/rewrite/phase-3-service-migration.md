# Phase 3: Service Module Migration — 2026-06-14

## Summary

Migrated all service modules from root-level and `shared/` locations into `src/`. Rewrote service entrypoints as coordination-mode-only. Added thin compatibility bridges at all old locations so existing Docker/deployment keeps working until Phase 5/6.

## New Service Folders Created

```
src/
├── coordinator/          (8 files: 7 service modules + index.js entrypoint)
├── worker/               (2 files: WorkerNode.js + index.js entrypoint)
├── pow-service/          (1 file: index.js entrypoint with inline POWService class)
└── telegram/             (28 files: telegramHandler + handlers + messages + combine + batch)
```

## Files Migrated

### Coordinator Service (`shared/coordinator/` → `src/coordinator/`)

| Old Path | New Path | Import Changes |
|----------|----------|----------------|
| `shared/coordinator/Coordinator.js` | `src/coordinator/Coordinator.js` | `../../logger` → `../shared/logger`, `../logger/structured` → `../shared/logger/structured`, `../redis/keys` → `../shared/redis/keys`, `../redis/client` → `../shared/redis/client`, `../../telegram/*` → `../telegram/*` |
| `shared/coordinator/JobQueueManager.js` | `src/coordinator/JobQueueManager.js` | `../../logger` → `../shared/logger`, `../redis/keys` → `../shared/redis/keys`, `../config/configService` → `../shared/config/configService` |
| `shared/coordinator/ProgressTracker.js` | `src/coordinator/ProgressTracker.js` | `../logger/structured` → `../shared/logger/structured`, `../redis/keys` → `../shared/redis/keys`, `../../telegram/messages` → `../telegram/messages` |
| `shared/coordinator/ProxyPoolManager.js` | `src/coordinator/ProxyPoolManager.js` | `../../logger` → `../shared/logger`, `../logger/structured` → `../shared/logger/structured`, `../redis/keys` → `../shared/redis/keys`, `../config/configService` → `../shared/config/configService` |
| `shared/coordinator/ChannelForwarder.js` | `src/coordinator/ChannelForwarder.js` | `../../logger` → `../shared/logger`, `../redis/client` → `../shared/redis/client`, `../../telegram/channelForwardStore` → `../telegram/channelForwardStore` |
| `shared/coordinator/MetricsManager.js` | `src/coordinator/MetricsManager.js` | `../logger/structured` → `../shared/logger/structured`, `../redis/keys` → `../shared/redis/keys` |
| `shared/coordinator/MetricsServer.js` | `src/coordinator/MetricsServer.js` | `../logger/structured` → `../shared/logger/structured` |

### Worker Service (`shared/worker/` → `src/worker/`)

| Old Path | New Path | Import Changes |
|----------|----------|----------------|
| `shared/worker/WorkerNode.js` | `src/worker/WorkerNode.js` | `../../logger` → `../shared/logger`, `../logger/structured` → `../shared/logger/structured`, `../../httpChecker` → `../shared/http/checker`, `../../automation/http/httpDataCapture` → `../shared/capture`, `../../automation/http/ipFetcher` → `../shared/http/ipFetcher`, `../../automation/batch/processedStore` → `../shared/batch/processedStore`, `../../automation/http/fingerprinting/powServiceClient` → `../shared/fingerprinting/powServiceClient`, `../redis/keys` → `../shared/redis/keys`, `../config/configService` → `../shared/config/configService` |

### Telegram (`telegram/` → `src/telegram/`)

| Old Path | New Path | Import Changes |
|----------|----------|----------------|
| `telegramHandler.js` | `src/telegram/telegramHandler.js` | `./httpChecker` → `../shared/http/checker`, `./automation/http/*` → `../shared/http/*`, `./automation/http/httpDataCapture` → `../shared/capture`, `./automation/batch/processedStore` → `../shared/batch/processedStore`, `./shared/config/configService` → `../shared/config/configService`, `./telegram/*` → `./messages`/`./combineHandler`/etc., `./logger` → `../shared/logger` |
| `telegram/combineHandler.js` | `src/telegram/combineHandler.js` | `../automation/batch/parse` → `../shared/batch/parse`, `../logger` → `../shared/logger`, `../shared/redis/keys` → `../shared/redis/keys` |
| `telegram/combineBatchRunner.js` | `src/telegram/combineBatchRunner.js` | `../automation/batch/processedStore` → `../shared/batch/processedStore`, `../automation/http/httpDataCapture` → `../shared/capture`, `../automation/http/sessionManager` → `../shared/http/sessionManager`, `../logger` → `../shared/logger`, `../shared/config/configService` → `../shared/config/configService` |
| `telegram/channelForwarder.js` | `src/telegram/channelForwarder.js` | `../logger` → `../shared/logger`, `../shared/config/configService` → `../shared/config/configService` |
| `telegram/channelForwardStore.js` | `src/telegram/channelForwardStore.js` | `../logger` → `../shared/logger` |
| `telegram/configHandler.js` | `src/telegram/configHandler.js` | `../shared/config/configService` → `../shared/config/configService`, `../shared/config/configSchema` → `../shared/config/configSchema`, `../logger` → `../shared/logger` |
| `telegram/exportHandler.js` | `src/telegram/exportHandler.js` | `../logger` → `../shared/logger` |
| `telegram/statusHandler.js` | `src/telegram/statusHandler.js` | `../logger` → `../shared/logger` |
| `telegram/messageTracker.js` | `src/telegram/messageTracker.js` | `../logger` → `../shared/logger` |
| `telegram/batch/index.js` | `src/telegram/batch/index.js` | `../../logger` → `../../shared/logger` |
| `telegram/batch/batchExecutor.js` | `src/telegram/batch/batchExecutor.js` | `../../logger` → `../../shared/logger`, `../../automation/batch/processedStore` → `../../shared/batch/processedStore`, `../../automation/http/httpDataCapture` → `../../shared/capture`, `../../automation/http/sessionManager` → `../../shared/http/sessionManager`, `../../shared/config/configService` → `../../shared/config/configService`, `../../shared/redis/keys` → `../../shared/redis/keys` |
| `telegram/batch/batchState.js` | `src/telegram/batch/batchState.js` | `../../logger` → `../../shared/logger` |
| `telegram/batch/circuitBreaker.js` | `src/telegram/batch/circuitBreaker.js` | `../../logger` → `../../shared/logger` |
| `telegram/batch/filterUtils.js` | `src/telegram/batch/filterUtils.js` | `../../logger` → `../../shared/logger`, `../../automation/batch/processedStore` → `../../shared/batch/processedStore` |
| `telegram/batch/documentHandler.js` | `src/telegram/batch/documentHandler.js` | `../../logger` → `../../shared/logger` |
| `telegram/batch/handlers/*.js` | `src/telegram/batch/handlers/*.js` | `../../../logger` → `../../../shared/logger`, `../../../automation/batch/*` → `../../../shared/batch/*`, `../../../automation/http/*` → `../../../shared/http/*` |
| `telegram/messages/*.js` | `src/telegram/messages/*.js` | No shared imports to update (pure message formatting) |

### HTTP Checker

| Old Path | New Path | Import Changes |
|----------|----------|----------------|
| `httpChecker.js` | `src/shared/http/checker.js` | `./automation/http/sessionManager` → `./sessionManager`, `./automation/http/httpFlow` → `./flow`, `./automation/http/htmlAnalyzer` → `./analyzer`, `./automation/http/httpDataCapture` → `../capture`, `./automation/http/ipFetcher` → `./ipFetcher`, `./logger` → `../logger`, `./automation/batch/parse` → `../batch/parse` |

## New Service Entrypoints

### `src/coordinator/index.js` — Coordinator-only entrypoint
- Validates environment for coordinator mode (`REDIS_URL`, `TELEGRAM_BOT_TOKEN`, `TARGET_LOGIN_URL` required)
- Connects Redis, initializes config service
- Creates Coordinator instance with Telegram bot
- Starts coordinator services (heartbeats, pub/sub, metrics, crash recovery)
- Registers graceful shutdown (waits for active batches, max 5 minutes)
- **No single-node fallback**

### `src/worker/index.js` — Worker-only entrypoint
- Validates `REDIS_URL` is present
- Connects Redis, initializes config service
- Creates WorkerNode instance
- Registers shutdown handlers
- **No single-node fallback**

### `src/pow-service/index.js` — POW service entrypoint
- Validates environment for pow-service mode
- Initializes Redis (optional, for caching)
- Initializes POW worker pool
- Starts Express HTTP server with /compute, /health, /metrics endpoints
- **No single-node fallback**

## Root Bridges Added

| Root File | Bridge Target | Purpose |
|-----------|--------------|---------|
| `main.js` | `require('./src/coordinator')` | Docker/package.json compatibility |
| `worker.js` | `require('./src/worker')` | Docker/package.json compatibility |
| `pow-service.js` | `require('./src/pow-service')` | Docker/package.json compatibility |
| `telegramHandler.js` | `require('./src/telegram/telegramHandler')` | Backward compatibility |

## Compatibility Bridges at Old Locations

| Old Location | Bridge Count | Bridge Target |
|-------------|-------------|---------------|
| `shared/coordinator/` | 7 files | `../../src/coordinator/` |
| `shared/worker/` | 1 file | `../../src/worker/` |
| `telegram/` (root files) | 10 files | `../src/telegram/` |
| `telegram/batch/` | 6 files | `../../src/telegram/batch/` |
| `telegram/batch/handlers/` | 5 files | `../../../src/telegram/batch/handlers/` |
| `telegram/messages/` | 6 files | `../../src/telegram/messages/` |
| `httpChecker.js` | 1 file | `./src/shared/http/checker` |

Total: **36 compatibility bridges** added in Phase 3 (in addition to 41 from Phase 2)

## HTTP Checker Placement Decision

`httpChecker.js` was moved to `src/shared/http/checker.js` because:
- It's used by both the coordinator (for `.chk` commands) and the worker (for task execution)
- It's a shared utility that performs HTTP credential checking
- It has no service-specific logic
- It depends only on other shared modules (http/flow, http/analyzer, capture, batch/parse)

## Single-Node Paths Removed from New Entrypoints

The new entrypoints (`src/coordinator/index.js`, `src/worker/index.js`, `src/pow-service/index.js`) have:
- No `isSingleNodeMode()` calls
- No `createCompatibilityLayer()` usage
- No JSONL fallback initialization
- No mode detection/auto-switching
- Each service validates its own required environment variables

## Single-Node Leftovers Still Present (Phase 4 Targets)

| File | Leftover | Action |
|------|----------|--------|
| `src/shared/config/environment.js` | `isSingleNodeMode()`, `getDeploymentMode()` returning 'single', single-node validation path | Phase 4: Remove single-node functions, simplify to coordinator/worker/pow-service only |
| `src/shared/batch/processedStore.js` | JSONL fallback code (`ensureFile`, `rewriteFile`, `hydrateJsonl`, JSONL backend branches) | Phase 4: Remove JSONL fallback, make Redis-only |
| `src/coordinator/Coordinator.js` | References to `../../telegram/channelForwardStore` (resolved via bridge) | Phase 6: Remove bridge dependency |

## Files Intentionally Left for Phase 4

| File/Directory | Reason |
|---------------|--------|
| `shared/compatibility/` (3 files) | Deprecated single-node mode — delete in Phase 4 |
| `tools/rakuten-manager/` (7 files) | Dead Go CLI tool — delete in Phase 4 |
| `config/` (4 files) | Stale deployment configs — delete in Phase 4 |
| Empty files (2) | `scripts/test-processed-store-performance.js`, `scripts/setup/fix-coordinator-no-docker.ps1` |
| Re-export facades (3) | `automation/http/httpDataCapture.js`, `telegram/messages.js`, `telegram/batchHandlers.js` (bridged) |

## Validation Results

- All 85+ new/modified files in `src/` pass `node -c` syntax validation
- All 36 bridge files at old locations pass `node -c` syntax validation
- Root bridges (`main.js`, `worker.js`, `pow-service.js`, `telegramHandler.js`) verified loading through to new modules
- `shared/coordinator/Coordinator` bridge verified
- `telegramHandler.js` bridge verified (exports: initializeTelegramHandler, parseCredentials, guardInput, isValidEmail, parseAllowedUserIds, isUserAllowed)
- `httpChecker.js` bridge verified (exports: checkCredentials)

## Risks and Unresolved Items

1. **Runtime verification incomplete** — Full startup tests require Redis. Syntax checks only.
2. **`shared/coordinator/index.js`** — Original barrel export was bridged, not deleted. Phase 6 cleanup.
3. **`shared/worker/index.js`** — Original barrel export was bridged, not deleted. Phase 6 cleanup.
4. **Test files** — `shared/coordinator/JobQueueManager.test.js`, `shared/coordinator/ProgressTracker.test.js`, `shared/worker/WorkerNode.test.js` still reference old paths. Phase 4 or test migration.
5. **`telegramHandler.js` root bridge** — The coordinator entrypoint imports from `../telegram/telegramHandler` directly, not through the root bridge. The root bridge exists only for backward compatibility with scripts that `require('./telegramHandler')`.
