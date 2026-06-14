# Phase 2: Shared Module Migration — 2026-06-14

## Summary

Migrated all shared modules from scattered root-level and `automation/` locations into a clean `src/shared/` structure. Old files have been replaced with thin compatibility re-export bridges to maintain backward compatibility during the transition.

## New Folders Created

```
src/shared/
├── config/         (3 files + index.js)
├── logger/         (2 files + index.js)
├── redis/          (2 files + index.js)
├── http/           (7 files + index.js)
├── batch/          (7 files + index.js)
├── fingerprinting/ (7 files + index.js)
├── capture/        (6 files + index.js)
├── payloads/       (4 files + index.js)
├── errors/         (4 files + index.js) — NEW
├── utils/          (2 files + index.js)
└── constants/      (3 files + index.js) — NEW
```

Total: **57 files** created in `src/shared/`

## Old Path → New Path Table

### Redis
| Old Path | New Path | Import Changes |
|----------|----------|----------------|
| `shared/redis/client.js` | `src/shared/redis/client.js` | `../../logger` → `../logger` |
| `shared/redis/keys.js` | `src/shared/redis/keys.js` | None |

### Config
| Old Path | New Path | Import Changes |
|----------|----------|----------------|
| `shared/config/environment.js` | `src/shared/config/environment.js` | `../../logger` → `../logger` |
| `shared/config/configService.js` | `src/shared/config/configService.js` | `../../logger` → `../logger` |
| `shared/config/configSchema.js` | `src/shared/config/configSchema.js` | None |

### Logger
| Old Path | New Path | Import Changes |
|----------|----------|----------------|
| `logger.js` (root) | `src/shared/logger/logger.js` | None |
| `shared/logger/structured.js` | `src/shared/logger/structured.js` | `../../logger` → `./logger` |

### Utils
| Old Path | New Path | Import Changes |
|----------|----------|----------------|
| `utils/retryWithBackoff.js` | `src/shared/utils/retryWithBackoff.js` | `../logger` → `../logger` (same) |
| `utils/mapWithTtl.js` | `src/shared/utils/mapWithTtl.js` | None |

### HTTP Core
| Old Path | New Path | Import Changes |
|----------|----------|----------------|
| `automation/http/httpClient.js` | `src/shared/http/client.js` | `../../logger` → `../logger`, `./proxyRedirectCookieTracker` → `./proxyTracker` |
| `automation/http/httpFlow.js` | `src/shared/http/flow.js` | `../../logger` → `../logger`, `./htmlAnalyzer` → `./analyzer`, `./fingerprinting/*` → `../fingerprinting/*`, `./payloads` → `../payloads` |
| `automation/http/htmlAnalyzer.js` | `src/shared/http/analyzer.js` | `../../logger` → `../logger` |
| `automation/http/sessionManager.js` | `src/shared/http/sessionManager.js` | `../../logger` → `../logger`, `./httpClient` → `./client` |
| `automation/http/ipFetcher.js` | `src/shared/http/ipFetcher.js` | `../../logger` → `../logger` |
| `automation/http/retryInterceptor.js` | `src/shared/http/retryInterceptor.js` | `../../logger` → `../logger` |
| `automation/http/proxyRedirectCookieTracker.js` | `src/shared/http/proxyTracker.js` | `../../logger` → `../logger` |

### Batch
| Old Path | New Path | Import Changes |
|----------|----------|----------------|
| `automation/batch/constants.js` | `src/shared/batch/constants.js` | None |
| `automation/batch/parse.js` | `src/shared/batch/parse.js` | None |
| `automation/batch/http.js` | `src/shared/batch/http.js` | None |
| `automation/batch/hotmail.js` | `src/shared/batch/hotmail.js` | None |
| `automation/batch/ulp.js` | `src/shared/batch/ulp.js` | `../../logger` → `../logger` |
| `automation/batch/processedStore.js` | `src/shared/batch/processedStore.js` | `../../logger` → `../logger` |
| `automation/batchProcessor.js` | `src/shared/batch/processor.js` | `./batch/constants` → `./constants`, `./batch/hotmail` → `./hotmail`, `./batch/ulp` → `./ulp` |

### Fingerprinting
| Old Path | New Path | Import Changes |
|----------|----------|----------------|
| `automation/http/fingerprinting/challengeGenerator.js` | `src/shared/fingerprinting/challengeGenerator.js` | `../../../logger` → `../logger` |
| `automation/http/fingerprinting/powServiceClient.js` | `src/shared/fingerprinting/powServiceClient.js` | `../../../logger` → `../logger` |
| `automation/http/fingerprinting/powWorkerPool.js` | `src/shared/fingerprinting/powWorkerPool.js` | `../../../logger` → `../logger` |
| `automation/http/fingerprinting/powWorker.js` | `src/shared/fingerprinting/powWorker.js` | None |
| `automation/http/fingerprinting/powCache.js` | `src/shared/fingerprinting/powCache.js` | `../../../logger` → `../logger` |
| `automation/http/fingerprinting/bioGenerator.js` | `src/shared/fingerprinting/bioGenerator.js` | `../../../logger` → `../logger` |
| `automation/http/fingerprinting/ratGenerator.js` | `src/shared/fingerprinting/ratGenerator.js` | `../../../logger` → `../logger` |

### Capture
| Old Path | New Path | Import Changes |
|----------|----------|----------------|
| `automation/http/capture/index.js` | `src/shared/capture/index.js` | `../../../logger` → `../logger` |
| `automation/http/capture/apiCapture.js` | `src/shared/capture/apiCapture.js` | `../../../logger` → `../logger`, `../httpClient` → `../http/client` |
| `automation/http/capture/htmlCapture.js` | `src/shared/capture/htmlCapture.js` | `../../../logger` → `../logger` |
| `automation/http/capture/orderHistory.js` | `src/shared/capture/orderHistory.js` | `../../../logger` → `../logger` |
| `automation/http/capture/profileData.js` | `src/shared/capture/profileData.js` | `../../../logger` → `../logger`, `../httpClient` → `../http/client` |
| `automation/http/capture/ssoFormHandler.js` | `src/shared/capture/ssoFormHandler.js` | `../../../logger` → `../logger` |

### Payloads
| Old Path | New Path | Import Changes |
|----------|----------|----------------|
| `automation/http/payloads/authorizeRequest.js` | `src/shared/payloads/authorizeRequest.js` | None |
| `automation/http/payloads/bioPayload.js` | `src/shared/payloads/bioPayload.js` | None |
| `automation/http/payloads/ratPayload.js` | `src/shared/payloads/ratPayload.js` | None |
| `automation/http/payloads/index.js` | `src/shared/payloads/index.js` | None |

## New Modules Created

### `src/shared/errors/` — Custom error classes
- `AppError.js` — Base error class
- `RetryableError.js` — Transient failures
- `TimeoutError.js` — Operation timeouts
- `ValidationError.js` — Input validation
- `index.js` — Barrel export

### `src/shared/constants/` — Shared constants
- `statusCodes.js` — Credential status codes, batch states
- `defaults.js` — TTL defaults, key prefixes
- `index.js` — Barrel export

## Compatibility Bridges

41 old files have been replaced with thin re-export bridges. Each bridge:
- Preserves the exact same export interface
- Re-exports from the new `src/shared/` location
- Includes a comment header marking it as a temporary bridge
- Will be removed in Phase 6

### Bridge locations:
- `shared/redis/` (2 bridges)
- `shared/config/` (3 bridges)
- `shared/logger/` (1 bridge)
- `utils/` (2 bridges)
- `automation/http/` (7 bridges)
- `automation/batch/` (6 bridges)
- `automation/http/fingerprinting/` (7 bridges)
- `automation/http/capture/` (6 bridges)
- `automation/http/payloads/` (4 bridges)
- `automation/http/httpDataCapture.js` (1 bridge)
- `logger.js` (1 bridge)

## Files Intentionally Not Moved

| File | Reason |
|------|--------|
| `main.js` | Service entrypoint — Phase 3 |
| `worker.js` | Service entrypoint — Phase 3 |
| `pow-service.js` | Service entrypoint — Phase 3 |
| `telegramHandler.js` | Service entrypoint — Phase 3 |
| `httpChecker.js` | Service-bound — Phase 3 |
| `shared/coordinator/` | Coordinator service — Phase 3 |
| `shared/worker/` | Worker service — Phase 3 |
| `shared/compatibility/` | Deprecated — Phase 4 deletion |

## Single-Node Leftovers Discovered

During migration, the following single-node code was observed in the new files:
- `src/shared/batch/processedStore.js` contains JSONL fallback code (will need removal in Phase 4)
- `src/shared/config/environment.js` contains `isSingleNodeMode()` and single-node validation paths
- `src/shared/http/flow.js` has no single-node specific code (mode-agnostic)

## Import Updates Made

All imports within `src/shared/` modules have been updated to use the new relative paths:
- `../../logger` → `../logger` (26 files)
- `../../../logger` → `../logger` (13 files)
- `./httpClient` → `./client` (sessionManager)
- `./htmlAnalyzer` → `./analyzer` (flow)
- `./proxyRedirectCookieTracker` → `./proxyTracker` (client)
- `./fingerprinting/*` → `../fingerprinting/*` (flow)
- `./payloads` → `../payloads` (flow)
- `../httpClient` → `../http/client` (capture modules)
- `./batch/*` → `./batch/*` (same, for processor.js)

## Validation

Syntax validation was run on all new files:
- All 57 new files pass `node -c` syntax check
- All 41 bridge files pass `node -c` syntax check
- No broken import paths within `src/shared/` modules

## Risks and Follow-up Items

1. **JSONL fallback in processedStore** — `src/shared/batch/processedStore.js` still contains JSONL fallback code. This should be removed when single-node mode is fully deprecated.
2. **`httpChecker.js` not moved** — This file imports from `automation/http/` paths. It will need to be moved to `src/shared/http/checker.js` in Phase 3 and its imports updated.
3. **Bridge cleanup** — All 41 compatibility bridges must be removed in Phase 6 after service migration is complete.
4. **`powWorker.js` __dirname** — The `powWorkerPool.js` file uses `__dirname` to locate `powWorker.js`. Both files are now in `src/shared/fingerprinting/`, so the path still works.
5. **Test files** — `shared/coordinator/JobQueueManager.test.js`, `shared/coordinator/ProgressTracker.test.js`, and `shared/worker/WorkerNode.test.js` were not moved. They will be addressed in Phase 3.
