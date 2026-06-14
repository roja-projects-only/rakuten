# New Folder Structure — 2026-06-14

## Design Principles

1. **One `src/` directory** — All application code lives under `src/`
2. **Service isolation** — Each service (coordinator, worker, pow-service) has its own directory
3. **Shared modules** — Common code lives in `src/shared/`
4. **No root-level JS files** — All JS files move into `src/`
5. **Clear entry points** — Each service has `index.js` as its entry
6. **Flat where possible** — Avoid deep nesting unless needed for clarity

## New Structure

```
src/
├── coordinator/
│   ├── index.js                    # Coordinator entry point (from main.js)
│   ├── coordinator.js              # Main orchestrator (from shared/coordinator/Coordinator.js)
│   ├── jobQueue.js                 # Job queue management (from shared/coordinator/JobQueueManager.js)
│   ├── progressTracker.js          # Progress tracking (from shared/coordinator/ProgressTracker.js)
│   ├── proxyPool.js                # Proxy pool management (from shared/coordinator/ProxyPoolManager.js)
│   ├── channelForwarder.js         # Distributed channel forwarding (from shared/coordinator/ChannelForwarder.js)
│   ├── metricsManager.js           # Metrics collection (from shared/coordinator/MetricsManager.js)
│   ├── metricsServer.js            # Metrics HTTP endpoint (from shared/coordinator/MetricsServer.js)
│   └── shutdown.js                 # Graceful shutdown logic (extracted from main.js)
│
├── worker/
│   ├── index.js                    # Worker entry point (from worker.js)
│   └── workerNode.js               # Worker execution loop (from shared/worker/WorkerNode.js)
│
├── pow-service/
│   ├── index.js                    # POW service entry point (from pow-service.js)
│   ├── compute.js                  # POW computation logic
│   └── cache.js                    # Redis caching layer
│
├── telegram/
│   ├── index.js                    # Telegram bot setup (from telegramHandler.js)
│   ├── commands/
│   │   ├── start.js                # /start command
│   │   ├── help.js                 # /help command
│   │   ├── stop.js                 # /stop command
│   │   ├── check.js                # .chk command
│   │   ├── proxy.js                # .proxy command
│   │   ├── config.js               # /config command (from telegram/configHandler.js)
│   │   ├── export.js               # /export command (from telegram/exportHandler.js)
│   │   └── status.js               # /status command (from telegram/statusHandler.js)
│   ├── batch/
│   │   ├── index.js                # Batch handler registration (from telegram/batch/index.js)
│   │   ├── documentHandler.js      # File upload handling (from telegram/batch/documentHandler.js)
│   │   ├── batchExecutor.js        # Batch execution (from telegram/batch/batchExecutor.js)
│   │   ├── batchState.js           # Batch state management (from telegram/batch/batchState.js)
│   │   ├── circuitBreaker.js       # Error rate monitoring (from telegram/batch/circuitBreaker.js)
│   │   ├── filterUtils.js          # Credential dedup filtering (from telegram/batch/filterUtils.js)
│   │   └── handlers/
│   │       ├── common.js           # Confirm/cancel/abort (from telegram/batch/handlers/common.js)
│   │       ├── hotmail.js          # HOTMAIL handler (from telegram/batch/handlers/hotmail.js)
│   │       ├── ulp.js              # ULP handler (from telegram/batch/handlers/ulp.js)
│   │       ├── jp.js               # JP handler (from telegram/batch/handlers/jp.js)
│   │       └── all.js              # ALL handler (from telegram/batch/handlers/all.js)
│   ├── combine/
│   │   ├── handler.js              # Combine UX (from telegram/combineHandler.js)
│   │   └── runner.js               # Combine batch execution (from telegram/combineBatchRunner.js)
│   └── messages/
│       ├── helpers.js              # MarkdownV2 utilities (from telegram/messages/helpers.js)
│       ├── static.js               # Start/help/guide messages (from telegram/messages/static.js)
│       ├── check.js                # Check result messages (from telegram/messages/checkMessages.js)
│       ├── capture.js              # Capture messages (from telegram/messages/captureMessages.js)
│       └── batch.js                # Batch messages (from telegram/messages/batchMessages.js)
│
└── shared/
    ├── config/
    │   ├── environment.js          # Env validation (from shared/config/environment.js)
    │   ├── configService.js        # Centralized config (from shared/config/configService.js)
    │   └── configSchema.js         # Config schema (from shared/config/configSchema.js)
    ├── logger/
    │   └── index.js                # Consolidated logger (from logger.js + shared/logger/structured.js)
    ├── redis/
    │   ├── client.js               # Redis client (from shared/redis/client.js)
    │   └── keys.js                 # Key schema (from shared/redis/keys.js)
    ├── http/
    │   ├── checker.js              # Credential checker (from httpChecker.js)
    │   ├── client.js               # Axios HTTP client (from automation/http/httpClient.js)
    │   ├── flow.js                 # Login flow (from automation/http/httpFlow.js)
    │   ├── analyzer.js             # Outcome detection (from automation/http/htmlAnalyzer.js)
    │   ├── sessionManager.js       # Session lifecycle (from automation/http/sessionManager.js)
    │   ├── ipFetcher.js            # Exit IP detection (from automation/http/ipFetcher.js)
    │   ├── retryInterceptor.js     # HTTP retry logic (from automation/http/retryInterceptor.js)
    │   └── proxyTracker.js         # Proxy redirect tracking (from automation/http/proxyRedirectCookieTracker.js)
    ├── batch/
    │   ├── parse.js                # File parsing (from automation/batch/parse.js)
    │   ├── processedStore.js       # Dedup cache (from automation/batch/processedStore.js)
    │   ├── constants.js            # Domain lists, limits (from automation/batch/constants.js)
    │   ├── hotmail.js              # HOTMAIL prep (from automation/batch/hotmail.js)
    │   ├── ulp.js                  # ULP prep (from automation/batch/ulp.js)
    │   └── http.js                 # HTTP batch utils (from automation/batch/http.js)
    ├── fingerprinting/
    │   ├── challengeGenerator.js   # POW algorithm (from automation/http/fingerprinting/challengeGenerator.js)
    │   ├── powServiceClient.js     # POW service client (from automation/http/fingerprinting/powServiceClient.js)
    │   ├── powWorkerPool.js        # Worker thread pool (from automation/http/fingerprinting/powWorkerPool.js)
    │   ├── powWorker.js            # Worker thread script (from automation/http/fingerprinting/powWorker.js)
    │   ├── powCache.js             # POW cache (from automation/http/fingerprinting/powCache.js)
    │   ├── bioGenerator.js         # Behavioral biometrics (from automation/http/fingerprinting/bioGenerator.js)
    │   └── ratGenerator.js         # RAT fingerprint (from automation/http/fingerprinting/ratGenerator.js)
    ├── capture/
    │   ├── index.js                # Capture orchestrator (from automation/http/capture/index.js)
    │   ├── apiCapture.js           # API-based capture (from automation/http/capture/apiCapture.js)
    │   ├── htmlCapture.js          # HTML fallback (from automation/http/capture/htmlCapture.js)
    │   ├── orderHistory.js         # Order data (from automation/http/capture/orderHistory.js)
    │   ├── profileData.js          # Profile & cards (from automation/http/capture/profileData.js)
    │   └── ssoFormHandler.js       # SSO handler (from automation/http/capture/ssoFormHandler.js)
    ├── payloads/
    │   ├── authorizeRequest.js     # Auth payload (from automation/http/payloads/authorizeRequest.js)
    │   ├── bioPayload.js           # Bio payload (from automation/http/payloads/bioPayload.js)
    │   └── ratPayload.js           # RAT payload (from automation/http/payloads/ratPayload.js)
    ├── errors/
    │   └── index.js                # Custom error classes (new)
    └── utils/
        ├── retryWithBackoff.js     # Retry utility (from utils/retryWithBackoff.js)
        ├── mapWithTtl.js           # TTL map (from utils/mapWithTtl.js)
        └── index.js                # Utility exports (new)

scripts/                            # Kept at root level
├── deploy/                         # Deployment scripts
├── setup/                          # Setup scripts
├── maintenance/                    # Maintenance scripts
├── migration/                      # Migration scripts
├── debug/                          # Debug scripts
└── tests/                          # Integration tests

tests/                              # New test directory
├── unit/                           # Unit tests for shared modules
│   ├── config/
│   ├── logger/
│   ├── redis/
│   └── utils/
├── integration/                    # Integration tests per service
│   ├── coordinator/
│   ├── worker/
│   └── pow-service/
└── e2e/                            # End-to-end tests

deployment/                         # Kept at root level
├── docker/
│   ├── Dockerfile.coordinator
│   ├── Dockerfile.worker
│   └── Dockerfile.pow-service
├── systemd/
│   ├── coordinator.service
│   ├── worker.service
│   └── pow-service.service
├── aws/
│   ├── user-data-coordinator.sh
│   ├── user-data-worker.sh
│   └── user-data-pow-service.sh
├── redis/
│   └── redis.conf
└── env-examples/
    ├── .env.coordinator.example
    ├── .env.worker.example
    └── .env.pow-service.example

docs/                               # Kept at root level
├── AUDIT_CURRENT_WORKSPACE.md
├── REWRITE_FOUNDATION.md
├── DEPRECATION_MAP.md
├── NEW_FOLDER_STRUCTURE.md
├── CLEANUP_AND_REWRITE_PLAN.md
├── AWS_SETUP_GUIDE.md
├── CONFIG_FEATURE_SUMMARY.md
├── ENVIRONMENT_VARIABLES.md
├── POW_SERVICE_INTEGRATION.md
├── QUICK_UPDATE.md
└── TESTING_CONFIG.md

# Root-level files
.env.example                        # Updated for coordination-only
.gitignore                          # Updated
.dockerignore                       # Updated
docker-compose.yml                  # Updated for new paths
package.json                        # Updated scripts and paths
README.md                           # Updated
AGENTS.md                           # Updated
AI_CONTEXT.md                       # Updated
railway.json                        # Updated start command
```

## Files Removed from Root

| Old File | New Location | Notes |
|----------|-------------|-------|
| `main.js` | `src/coordinator/index.js` | Rewritten for coordination-only |
| `worker.js` | `src/worker/index.js` | Rewritten |
| `pow-service.js` | `src/pow-service/index.js` | Rewritten |
| `telegramHandler.js` | `src/telegram/index.js` | Rewritten |
| `httpChecker.js` | `src/shared/http/checker.js` | Moved |
| `logger.js` | `src/shared/logger/index.js` | Consolidated |

## Directories Removed

| Old Directory | Reason |
|---------------|--------|
| `tools/rakuten-manager/` | Go CLI tool, separate project |
| `config/` | Stale deployment configs |
| `shared/compatibility/` | Deprecated single-node mode |
| `automation/` | Reorganized into `src/shared/` |
| `utils/` | Moved to `src/shared/utils/` |

## Import Path Changes

| Old Import | New Import |
|------------|------------|
| `require('./logger')` | `require('./shared/logger')` |
| `require('./httpChecker')` | `require('./shared/http/checker')` |
| `require('./telegramHandler')` | `require('./telegram')` |
| `require('./shared/coordinator/Coordinator')` | `require('./coordinator/coordinator')` |
| `require('./shared/worker/WorkerNode')` | `require('./worker/workerNode')` |
| `require('./shared/redis/client')` | `require('./shared/redis/client')` (same) |
| `require('./shared/config/configService')` | `require('./shared/config/configService')` (same) |
| `require('./automation/http/httpFlow')` | `require('./shared/http/flow')` |
| `require('./automation/batch/processedStore')` | `require('./shared/batch/processedStore')` |
| `require('./automation/http/fingerprinting/challengeGenerator')` | `require('./shared/fingerprinting/challengeGenerator')` |
