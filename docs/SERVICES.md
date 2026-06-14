# Services

## Coordinator Service

**Location**: `src/coordinator/`  
**Entry**: `src/coordinator/index.js`  
**Purpose**: Telegram bot and job orchestration

### Responsibilities
- Telegram bot setup and command handling
- Job queue management (enqueue, cancel, status)
- Progress tracking (init, update, summary)
- Channel forwarding (distributed via pub/sub)
- Proxy pool management
- Metrics collection and HTTP endpoint
- Graceful shutdown with batch completion wait

### Key Files
- `index.js` — Service entrypoint (env validation, Redis, Telegram bot, shutdown)
- `Coordinator.js` — Main orchestrator (heartbeats, pub/sub, metrics, crash recovery)
- `JobQueueManager.js` — Redis-based task queue
- `ProgressTracker.js` — Batch progress tracking with Telegram message updates
- `ProxyPoolManager.js` — Round-robin proxy assignment with health checks
- `ChannelForwarder.js` — Distributed channel forwarding via pub/sub events
- `MetricsManager.js` — Prometheus metrics collection
- `MetricsServer.js` — HTTP metrics endpoint

### Required Environment Variables
- `TELEGRAM_BOT_TOKEN` — Bot token from @BotFather
- `TARGET_LOGIN_URL` — Rakuten OAuth login URL
- `REDIS_URL` — Redis connection URL

### Optional Environment Variables
- `FORWARD_CHANNEL_ID` — Channel ID for VALID credentials
- `ALLOWED_USER_IDS` — Comma-separated allowed user IDs
- `METRICS_PORT` — Prometheus metrics port (default: 9090)
- `BATCH_CONCURRENCY` — Parallel checks (default: 1)
- `BATCH_MAX_RETRIES` — Retry count (default: 2)
- `BATCH_DELAY_MS` — Chunk delay (default: 50)
- `BATCH_HUMAN_DELAY_MS` — Human delay multiplier (default: 0)
- `PROXY_SERVER` — Single proxy URL
- `PROXY_POOL` — Comma-separated proxy URLs
- `PROCESSED_TTL_MS` — Cache TTL (default: 30 days)
- `FORWARD_TTL_MS` — Forward tracking TTL (default: 30 days)

---

## Worker Service

**Location**: `src/worker/`  
**Entry**: `src/worker/index.js`  
**Purpose**: Credential checking workers

### Responsibilities
- Redis connection and task dequeue
- Credential checking (HTTP flow)
- POW computation (local or via POW service)
- Result storage (processed store)
- Progress reporting
- Heartbeat management
- Graceful shutdown

### Key Files
- `index.js` — Service entrypoint (Redis connection, task dequeue)
- `WorkerNode.js` — Worker execution loop

### Required Environment Variables
- `REDIS_URL` — Redis connection URL

### Optional Environment Variables
- `WORKER_ID` — Worker identifier (auto-generated)
- `WORKER_CONCURRENCY` — Concurrent tasks (default: 3)
- `WORKER_TASK_TIMEOUT` — Task timeout (default: 120000)
- `WORKER_HEARTBEAT_INTERVAL` — Heartbeat interval (default: 10000)
- `WORKER_QUEUE_TIMEOUT` — Queue timeout (default: 30000)
- `POW_SERVICE_URL` — POW service endpoint

---

## POW Service

**Location**: `src/pow-service/`  
**Entry**: `src/pow-service/index.js`  
**Purpose**: Proof-of-work computation service

### Responsibilities
- HTTP API for POW computation
- Redis caching layer
- Worker thread pool
- Health and metrics endpoints
- Graceful shutdown

### Key Files
- `index.js` — Service entrypoint with inline POWService class

### API Endpoints
- `POST /compute` — Compute POW cres value
  - Request: `{ "mask": "0000", "key": "abc123", "seed": 12345 }`
  - Response: `{ "cres": "abc123xyz789abcd", "cached": false, "computeTimeMs": 234 }`
- `GET /health` — Health check with cache statistics
- `GET /metrics` — Prometheus metrics

### Optional Environment Variables
- `PORT` — HTTP port (default: 3001)
- `REDIS_URL` — For caching (optional)
- `POW_NUM_WORKERS` — Worker threads (default: CPU-1)
- `POW_TASK_TIMEOUT` — Task timeout (default: 30000)

---

## Telegram Bot

**Location**: `src/telegram/`  
**Purpose**: Telegram bot handlers and message formatting

### Responsibilities
- Bot setup and command registration
- Command handlers (/start, /help, /stop, .chk, .proxy, /config, /export, /status)
- Batch processing handlers
- Combine mode handlers
- Channel forwarding
- Message formatting (MarkdownV2)

### Key Files
- `telegramHandler.js` — Bot setup and command registration
- `messages/` — MarkdownV2 helpers and message builders
- `batch/` — Batch processing (index, documentHandler, batchExecutor, batchState, circuitBreaker, filterUtils, handlers/)
- `combineHandler.js` — Combine mode UX (/combine → /done)
- `combineBatchRunner.js` — Combine batch execution
- `channelForwarder.js` — Channel forward dedupe
- `channelForwardStore.js` — Forward dedupe (Redis)
- `configHandler.js` — Centralized config via Telegram (/config)
- `exportHandler.js` — Export VALID credentials (/export)
- `statusHandler.js` — /status command
- `messageTracker.js` — Forwarded message tracking

### Common Commands
- `/start` — Welcome message with quick-action buttons
- `.chk user:pass` — Single check (auto capture on VALID)
- `.proxy` — Show current proxy status
- `.ulp <url>` — Process ULP data from URL
- `/stop` — Abort active batch/combine
- `/combine` → upload files → `/done` → choose type → confirm
- `/config` — View/set centralized config
- `/export` — Export VALID credentials
- `/status` — System health

### Critical Patterns
- For long work in Telegram callbacks, wrap with `setTimeout(() => { ... }, 0)` to avoid Telegraf timeouts
- Always use `parse_mode: 'MarkdownV2'` with `escapeV2/codeV2/boldV2` helpers
- Close sessions (`closeSession`) in `.chk` even on errors
- Use Redis-backed dedupe: `processedStore` for processed creds, `channelForwardStore` for forwarded creds
