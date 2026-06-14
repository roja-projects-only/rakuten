# Phase 4: Deprecated Code Cleanup — 2026-06-14

## Summary

Removed all deprecated single-node mode code, dead files, and obsolete directories from the workspace. The project now runs exclusively in coordination mode (coordinator + worker + pow-service).

## Directories Deleted

| Directory | Files | Reason |
|-----------|-------|--------|
| `shared/compatibility/` | 3 files | Deprecated single-node mode implementation |
| `tools/rakuten-manager/` | 9 files | Dead Go CLI tool with hardcoded IPs |
| `config/` | 4 files | Stale deployment configs with hardcoded tokens |
| `scripts/setup/` | 1 file | Empty fix script |

**Total: 17 files deleted**

## Files Deleted

| File | Reason |
|------|--------|
| `shared/compatibility/index.js` | CompatibilityLayer with single-node detection |
| `shared/compatibility/SingleNodeMode.js` | In-memory job queue, mock distributed components |
| `shared/compatibility/GracefulDegradation.js` | Fallback wrappers for single-node mode |
| `tools/rakuten-manager/main.go` | Go CLI tool entry point |
| `tools/rakuten-manager/config.go` | Go CLI config |
| `tools/rakuten-manager/operations.go` | Go CLI operations |
| `tools/rakuten-manager/ssh.go` | Go CLI SSH utility |
| `tools/rakuten-manager/config.yaml` | Go CLI config |
| `tools/rakuten-manager/go.mod` | Go module definition |
| `tools/rakuten-manager/go.sum` | Go module checksums |
| `tools/rakuten-manager/README.md` | Go CLI documentation |
| `tools/rakuten-manager/rakuten-manager.exe` | Compiled Go binary |
| `config/.env.local` | Local dev config with hardcoded tokens |
| `config/.env.coordinator` | Stale deployment config |
| `config/.env.example` | Outdated template |
| `config/README.md` | Stale documentation |
| `scripts/test-processed-store-performance.js` | Empty file (0 bytes) |
| `scripts/setup/fix-coordinator-no-docker.ps1` | Empty file (0 bytes) |

## Single-Node Functions Removed

| Function | File | Action |
|----------|------|--------|
| `isSingleNodeMode()` | `src/shared/config/environment.js` | Removed entirely |
| `getDeploymentMode()` returning `'single'` | `src/shared/config/environment.js` | Simplified to only return coordinator/worker/pow-service |
| `single` mode validation | `src/shared/config/environment.js` | Removed from `modeRequirements` |
| `runSingleNodeBatch()` | `src/telegram/batch/batchExecutor.js` | Removed entirely |
| `buildSingleNodeStatus()` | `src/telegram/statusHandler.js` | Removed entirely |

## JSONL Fallback Removal

### `src/shared/batch/processedStore.js`

**Before:** Dual backend (Redis with JSONL fallback)
- `backend` variable tracking `'redis'` or `'jsonl'`
- `ensureFile()`, `rewriteFile()`, `hydrateJsonl()` functions for JSONL
- `cache` Map for JSONL in-memory storage
- `STORE_PATH` for JSONL file location
- Silent fallback to JSONL when Redis unavailable

**After:** Redis-only
- `REDIS_URL` is required — throws clear error if missing
- No `backend` variable — always Redis
- No JSONL functions — removed entirely
- No `cache` Map — removed entirely
- No `STORE_PATH` — removed entirely
- `initProcessedStore()` throws if `REDIS_URL` not set
- `pruneExpired()` is now a no-op (Redis handles TTL via SETEX)

### `src/telegram/channelForwardStore.js`

**Before:** Dual backend (Redis with JSONL fallback)
- Same pattern as processedStore: `backend`, `ensureFile()`, `hydrateJsonl()`, `rewriteFile()`, `cache`, `STORE_PATH`

**After:** Redis-only
- `REDIS_URL` is required — throws clear error if missing
- No JSONL functions — removed entirely
- No `cache` Map — removed entirely
- No `STORE_PATH` — removed entirely

## Environment Config Cleanup

### `src/shared/config/environment.js`

**Removed:**
- `isSingleNodeMode()` function (lines 534-538)
- `single` entry from `modeRequirements` object
- `isSingleNodeMode` from module exports

**Changed:**
- `getDeploymentMode()` — now returns `'worker'` as default instead of `'single'`
- Comments updated: "Only required in coordinator mode or single-node mode" → "Only required in coordinator mode"
- `BATCH_CONCURRENCY` description: "single-node mode" → "batch mode"

**Kept:**
- `isDistributedMode()` — still useful for checking Redis availability
- `getDeploymentMode()` — returns coordinator/worker/pow-service based on env vars
- `validateEnvironment()` — validates based on service mode

## Telegram Batch Cleanup

### `src/telegram/batch/batchExecutor.js`

**Removed:**
- `runSingleNodeBatch()` function (entire function, ~230 lines)
- Single-node batch processing logic (inline credential checking)
- Circuit breaker for single-node mode
- Direct `checkCredentials()` calls in single-node path

**Changed:**
- `runBatchExecution()` — now always queues to Redis via `runDistributedBatch()`
- Removed `options.compatibility.isDistributed()` check — assumes distributed always
- Removed debug logging of `isDistributed` and `mode`

**Kept:**
- `runDistributedBatch()` — queues batch to Redis for worker processing
- `getBatchConfig()` — reads hot-reloadable config
- Progress update message formatting

### `src/telegram/statusHandler.js`

**Removed:**
- `buildSingleNodeStatus()` function (entire function, ~20 lines)
- Single-node status message with "Single-node (Railway)" mode display
- Fallback to single-node status when no coordinator provided

**Changed:**
- `registerStatusHandler()` — `coordinator` parameter is now required (not optional)
- Shows error message if no coordinator provided instead of single-node status

## Compatibility Bridges Removed

None in this phase. Bridges from Phase 2 and Phase 3 are still needed until Phase 5/6 updates Docker/deployment paths.

## Compatibility Bridges Kept

All 77 bridges (41 from Phase 2 + 36 from Phase 3) are retained because:
- Root entrypoints (`main.js`, `worker.js`, `pow-service.js`) still use them
- Docker/package scripts haven't been updated yet
- Some test files may still reference old paths

## Import Updates Made

No import updates were needed — the deleted files were not imported by any `src/` modules.

## Remaining Single-Node References

After cleanup, the following references remain in the workspace:

| Location | Reference | Status |
|----------|-----------|--------|
| `docs/AUDIT_CURRENT_WORKSPACE.md` | Documentation of single-node mode | DOCS ONLY |
| `docs/DEPRECATION_MAP.md` | Catalog of removed items | DOCS ONLY |
| `docs/PHASE_3_SERVICE_MIGRATION.md` | Notes about single-node leftovers | DOCS ONLY |
| `AGENTS.md` | Agent instructions mentioning compatibility | DOCS ONLY |
| `AI_CONTEXT.md` | Architecture context | DOCS ONLY |
| `CLEANUP_REPORT.md` | Historical cleanup notes | DOCS ONLY |

All references in `src/` code have been removed.

## Validation Results

### Syntax Checks

All changed files pass `node -c` syntax validation:

```
✓ src/shared/config/environment.js
✓ src/shared/batch/processedStore.js
✓ src/telegram/channelForwardStore.js
✓ src/telegram/batch/batchExecutor.js
✓ src/telegram/statusHandler.js
✓ src/coordinator/index.js
✓ src/worker/index.js
✓ src/pow-service/index.js
```

### Reference Scan

No single-node references remain in `src/` directory:
- `isSingleNodeMode` — 0 matches
- `SingleNode` — 0 matches
- `single-node` — 0 matches
- `createCompatibilityLayer` — 0 matches
- `CompatibilityLayer` — 0 matches
- `processBatchLegacy` — 0 matches
- `processed.jsonl` — 0 matches
- `JSONL` — 0 matches
- `jsonl` — 0 matches

## .gitignore and .dockerignore Updates

### `.gitignore`

Removed:
```
!config/.env.local
!config/.env.coordinator
```

### `.dockerignore`

Removed:
```
config/.env.*
```

## Risks and Follow-up Items

### Low Risk

1. **`scripts/setup/` directory** — May be empty after deleting `fix-coordinator-no-docker.ps1`. Other scripts in `scripts/` should be verified.

2. **Test files** — `shared/coordinator/JobQueueManager.test.js`, `shared/coordinator/ProgressTracker.test.js`, `shared/worker/WorkerNode.test.js` still reference old paths. These are in the old `shared/` location and will be addressed in Phase 6.

### Medium Risk

3. **`channelForwardStore.js` JSONL removal** — If any code path initializes this store without `REDIS_URL`, it will now throw instead of silently falling back. This is intentional — Redis is required.

4. **`processedStore.js` JSONL removal** — Same as above. Any code that relied on JSONL fallback will now fail with clear error.

### No Risk

5. **Deleted directories** — Verified no imports from `shared/compatibility/`, `tools/rakuten-manager/`, or `config/` exist in `src/`.

6. **Environment config** — `isSingleNodeMode()` was exported but not imported by any `src/` module. Safe to remove.

## Phase 4 Status: **COMPLETE**

## Recommended Next Prompt for Phase 5

> "Phase 5: Update Docker and deployment configuration — Update `Dockerfile.coordinator`, `Dockerfile.worker`, `Dockerfile.pow-service` to use `src/` paths. Update `docker-compose.yml` commands and healthchecks. Update `railway.json` start command. Update `package.json` scripts to use `src/coordinator/index.js`, `src/worker/index.js`, `src/pow-service/index.js`. Update deployment scripts in `deployment/` directory."
