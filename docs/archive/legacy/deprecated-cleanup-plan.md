# Cleanup and Rewrite Plan — 2026-06-14

## Overview

This document provides a practical, ordered plan for transforming the current workspace into the new modular structure. Each step is designed to be safe — no step deletes files that haven't been verified as dead, and no step breaks the working system without a replacement in place.

## Files to Move

### Phase 2: Shared Modules (no service dependencies)

| Source | Destination | Notes |
|--------|-------------|-------|
| `shared/redis/client.js` | `src/shared/redis/client.js` | Update logger import |
| `shared/redis/keys.js` | `src/shared/redis/keys.js` | No changes needed |
| `shared/config/environment.js` | `src/shared/config/environment.js` | Remove single-node paths |
| `shared/config/configService.js` | `src/shared/config/configService.js` | Update logger import |
| `shared/config/configSchema.js` | `src/shared/config/configSchema.js` | No changes needed |
| `utils/retryWithBackoff.js` | `src/shared/utils/retryWithBackoff.js` | Update logger import |
| `utils/mapWithTtl.js` | `src/shared/utils/mapWithTtl.js` | No changes needed |
| `automation/http/httpClient.js` | `src/shared/http/client.js` | Update logger import |
| `automation/http/httpFlow.js` | `src/shared/http/flow.js` | Update logger import |
| `automation/http/htmlAnalyzer.js` | `src/shared/http/analyzer.js` | Update logger import |
| `automation/http/sessionManager.js` | `src/shared/http/sessionManager.js` | Update logger import |
| `automation/http/ipFetcher.js` | `src/shared/http/ipFetcher.js` | Update logger import |
| `automation/http/retryInterceptor.js` | `src/shared/http/retryInterceptor.js` | Update logger import |
| `automation/http/proxyRedirectCookieTracker.js` | `src/shared/http/proxyTracker.js` | Update logger import |
| `automation/batch/parse.js` | `src/shared/batch/parse.js` | Update logger import |
| `automation/batch/processedStore.js` | `src/shared/batch/processedStore.js` | Remove JSONL fallback |
| `automation/batch/constants.js` | `src/shared/batch/constants.js` | No changes needed |
| `automation/batch/hotmail.js` | `src/shared/batch/hotmail.js` | Update imports |
| `automation/batch/ulp.js` | `src/shared/batch/ulp.js` | Update imports |
| `automation/batch/http.js` | `src/shared/batch/http.js` | Update imports |
| `automation/http/fingerprinting/*` | `src/shared/fingerprinting/*` | Update imports |
| `automation/http/capture/*` | `src/shared/capture/*` | Update imports |
| `automation/http/payloads/*` | `src/shared/payloads/*` | Update imports |
| `automation/batchProcessor.js` | `src/shared/batch/processor.js` | Update imports |
| `logger.js` + `shared/logger/structured.js` | `src/shared/logger/index.js` | Consolidate |

### Phase 3: Service Modules

| Source | Destination | Notes |
|--------|-------------|-------|
| `shared/coordinator/Coordinator.js` | `src/coordinator/coordinator.js` | Remove compatibility layer refs |
| `shared/coordinator/JobQueueManager.js` | `src/coordinator/jobQueue.js` | Update imports |
| `shared/coordinator/ProgressTracker.js` | `src/coordinator/progressTracker.js` | Update imports |
| `shared/coordinator/ProxyPoolManager.js` | `src/coordinator/proxyPool.js` | Update imports |
| `shared/coordinator/ChannelForwarder.js` | `src/coordinator/channelForwarder.js` | Update imports |
| `shared/coordinator/MetricsManager.js` | `src/coordinator/metricsManager.js` | Update imports |
| `shared/coordinator/MetricsServer.js` | `src/coordinator/metricsServer.js` | Update imports |
| `shared/worker/WorkerNode.js` | `src/worker/workerNode.js` | Update imports |
| `telegram/` | `src/telegram/` | Update all imports |
| `httpChecker.js` | `src/shared/http/checker.js` | Update imports |

### Phase 4: Entry Points

| Source | Destination | Notes |
|--------|-------------|-------|
| `main.js` | `src/coordinator/index.js` | Rewrite: remove single-node paths |
| `worker.js` | `src/worker/index.js` | Rewrite: simplify imports |
| `pow-service.js` | `src/pow-service/index.js` | Rewrite: simplify imports |

## Files to Delete

### Immediate (Phase 4)

| File | Reason |
|------|--------|
| `tools/rakuten-manager/` (7 files) | Go CLI tool, separate project |
| `config/.env.coordinator` | Stale deployment config |
| `config/.env.local` | Contains hardcoded tokens |
| `config/.env.example` | Outdated template |
| `config/README.md` | Stale documentation |
| `scripts/test-processed-store-performance.js` | Empty file |
| `scripts/setup/fix-coordinator-no-docker.ps1` | Empty file |
| `scripts/maintenance/clear-redis-conflicts.js` | Superseded by fix-redis-data.js |
| `scripts/setup/fix-coordinator-issue.ps1` | Superseded by simpler alternatives |
| `scripts/deploy/README.md` | Redundant |
| `ssh-logs.bat` | Debug utility |
| `debug-connection.ps1` | Debug utility |

### After Migration (Phase 6)

| File | Reason |
|------|--------|
| `shared/compatibility/SingleNodeMode.js` | Deprecated |
| `shared/compatibility/GracefulDegradation.js` | Deprecated |
| `shared/compatibility/index.js` | Deprecated |
| `shared/compatibility/` (directory) | Empty after file deletion |
| `automation/http/httpDataCapture.js` | Re-export facade |
| `telegram/messages.js` | Re-export facade |
| `telegram/batchHandlers.js` | Re-export facade |
| `shared/coordinator/index.js` | Barrel export |
| `shared/worker/index.js` | Barrel export |
| `shared/logger/structured.js` | Consolidated into new logger |
| Old root-level JS files | Moved to src/ |
| `automation/` (directory) | Empty after moves |
| `utils/` (directory) | Empty after moves |

## Files to Rewrite

| File | Changes |
|------|---------|
| `main.js` → `src/coordinator/index.js` | Remove compatibility layer, single-node paths, simplify to coordinator-only |
| `telegramHandler.js` → `src/telegram/index.js` | Remove single-node `/stop` path, simplify imports |
| `telegram/batch/batchExecutor.js` | Remove `isDistributed()` branching, assume distributed |
| `telegram/combineBatchRunner.js` | Rewrite for distributed execution |
| `telegram/combineHandler.js` | Remove single-node paths |
| `telegram/statusHandler.js` | Remove single-node fallback status |
| `shared/config/environment.js` | Remove single-node mode, make `REDIS_URL` required |
| `automation/batch/processedStore.js` | Remove JSONL fallback, Redis-only |
| `logger.js` + `shared/logger/structured.js` | Consolidate into single module |

## Root Files to Remove or Relocate

| File | Action | Notes |
|------|--------|-------|
| `main.js` | Relocate | → `src/coordinator/index.js` |
| `worker.js` | Relocate | → `src/worker/index.js` |
| `pow-service.js` | Relocate | → `src/pow-service/index.js` |
| `telegramHandler.js` | Relocate | → `src/telegram/index.js` |
| `httpChecker.js` | Relocate | → `src/shared/http/checker.js` |
| `logger.js` | Relocate | → `src/shared/logger/index.js` |
| `railway.json` | Update | Change start command to `node src/coordinator/index.js` |
| `docker-compose.yml` | Update | Update volume mounts and commands |

## Package Scripts to Replace

| Old Script | New Script | Notes |
|------------|------------|-------|
| `start` | `node src/coordinator/index.js` | Updated path |
| `dev` | `node src/coordinator/index.js` | Updated path |
| `start:pow-service` | `node src/pow-service/index.js` | Updated path |
| `test:*` | Keep as-is | Test scripts reference by path |

## Docker Files to Update

| File | Changes |
|------|---------|
| `Dockerfile.coordinator` | COPY paths → `src/coordinator/`, `src/shared/`, `src/telegram/` |
| `Dockerfile.worker` | COPY paths → `src/worker/`, `src/shared/` |
| `Dockerfile.pow-service` | COPY paths → `src/pow-service/`, `src/shared/` |
| `docker-compose.yml` | Update healthcheck commands if needed |

## Dependencies to Remove

| Package | Reason |
|---------|--------|
| (none immediately) | All current deps are used |

Note: `redis` (non-ioredis) is used only in test scripts. Can be removed later if tests are updated to use ioredis.

## Dependencies to Keep

All 15 current dependencies are in use and should be kept.

## Dependencies to Update Later

| Package | Action | Notes |
|---------|--------|-------|
| `redis` | Consider removing | Only used in test scripts; standardize on ioredis |
| `murmurhash-native` | Keep as optional | Linux-only native speedup |

## Environment Variables to Keep

All current environment variables are used and should be kept.

## Environment Variables to Remove

| Variable | Reason |
|----------|--------|
| (none) | All vars are used in coordination mode |

## Environment Variables to Rename

| Old Name | New Name | Notes |
|----------|----------|-------|
| (none) | — | Current names are fine |

## Environment Variables That Need Validation

| Variable | Issue |
|----------|-------|
| `REDIS_URL` | Should be required (not optional) in coordination-only mode |
| `POW_SERVICE_TIMEOUT` | Referenced in env but not in code — verify usage |

## Safe Order of Operations

### Step 1: Create directory structure
```
mkdir -p src/coordinator src/worker src/pow-service src/telegram/commands src/telegram/batch/handlers src/telegram/combine src/telegram/messages src/shared/config src/shared/logger src/shared/redis src/shared/http src/shared/batch src/shared/fingerprinting src/shared/capture src/shared/payloads src/shared/errors src/shared/utils
```

### Step 2: Move shared modules (no interdependencies)
- Move `shared/redis/` → `src/shared/redis/`
- Move `utils/` → `src/shared/utils/`
- Move `shared/config/` → `src/shared/config/`
- Create `src/shared/logger/index.js` (consolidated)

### Step 3: Move HTTP and batch modules
- Move `automation/http/` → `src/shared/http/`
- Move `automation/batch/` → `src/shared/batch/`
- Move `automation/batchProcessor.js` → `src/shared/batch/processor.js`

### Step 4: Move coordinator modules
- Move `shared/coordinator/` → `src/coordinator/`
- Move `telegram/` → `src/telegram/`
- Create `src/coordinator/index.js` (from main.js)

### Step 5: Move worker modules
- Move `shared/worker/` → `src/worker/`
- Create `src/worker/index.js` (from worker.js)

### Step 6: Move POW service
- Create `src/pow-service/index.js` (from pow-service.js)

### Step 7: Update all imports
- Update all `require()` paths in moved files
- Verify no broken imports

### Step 8: Update build and deploy
- Update Dockerfiles
- Update package.json scripts
- Update docker-compose.yml
- Update railway.json

### Step 9: Delete deprecated code
- Delete `shared/compatibility/`
- Delete `tools/rakuten-manager/`
- Delete `config/`
- Delete empty files
- Delete re-export facades

### Step 10: Delete old files
- Delete old root-level JS files
- Delete empty directories
- Update documentation

### Step 11: Verify
- Run `npm install`
- Run `node src/coordinator/index.js` (verify startup)
- Run `node src/worker/index.js` (verify startup)
- Run `node src/pow-service/index.js` (verify startup)
- Run `docker-compose build` (verify Docker builds)
- Run integration tests
