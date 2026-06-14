# Rakuten Credential Checker — AI Context

Use this as the deep reference for the current workspace. For quick rules, see [AGENTS.md](AGENTS.md).

## 1) Architecture Map
```
src/coordinator/index.js            # Coordinator entrypoint (env validation, Redis, Telegram bot, shutdown)
src/coordinator/Coordinator.js      # Main orchestrator (heartbeats, pub/sub, metrics, crash recovery)
src/coordinator/JobQueueManager.js  # Redis-based task queue
src/coordinator/ProgressTracker.js  # Batch progress tracking
src/coordinator/ProxyPoolManager.js # Proxy rotation
src/coordinator/ChannelForwarder.js # Distributed channel forwarding
src/coordinator/MetricsManager.js   # Prometheus metrics
src/coordinator/MetricsServer.js    # Metrics HTTP endpoint

src/worker/index.js                 # Worker entrypoint (Redis connection, task dequeue)
src/worker/WorkerNode.js            # Worker execution loop

src/pow-service/index.js            # POW HTTP service (port 3001, optional Redis cache)

src/telegram/telegramHandler.js     # Telegram bot setup, commands (/start, /help, /stop, .chk, .proxy), callbacks
src/telegram/messages/              # MarkdownV2 helpers + message builders (static, check, capture, batch)
src/telegram/batch/                 # Batch processing (index, documentHandler, batchExecutor, batchState, circuitBreaker, filterUtils, handlers/)
src/telegram/combineHandler.js      # Combine mode UX (/combine → /done)
src/telegram/combineBatchRunner.js  # Combine batch execution
src/telegram/channelForwarder.js    # Channel forward dedupe
src/telegram/channelForwardStore.js # Forward dedupe (Redis)
src/telegram/configHandler.js       # Centralized config via Telegram (/config)
src/telegram/exportHandler.js       # Export VALID credentials (/export)
src/telegram/statusHandler.js       # /status command
src/telegram/messageTracker.js      # Forwarded message tracking

src/shared/config/configService.js  # Centralized config (Redis pub/sub); env fallback
src/shared/config/configSchema.js   # Schema: hot-reloadable variables with type/range validation
src/shared/config/environment.js    # validateEnvironment (coordinator/worker/pow-service modes)
src/shared/redis/                   # client.js (Redis connection), keys.js (key prefixes)
src/shared/logger/                  # Structured logger (createLogger)
src/shared/http/                    # checker, client, flow, analyzer, sessionManager, ipFetcher, retryInterceptor, proxyTracker
src/shared/batch/                   # parse, processedStore, constants, hotmail, ulp, http
src/shared/fingerprinting/          # challengeGenerator, powServiceClient, powWorkerPool, powWorker, powCache, bioGenerator, ratGenerator
src/shared/capture/                 # apiCapture, htmlCapture, orderHistory, profileData, ssoFormHandler
src/shared/payloads/                # authorizeRequest, bioPayload, ratPayload
src/shared/errors/                  # Custom error classes
src/shared/utils/                   # retryWithBackoff, mapWithTtl
```

## 2) Modes
- **Distributed (coordinator/worker)**: coordinator queues tasks to Redis; workers process. Progress/forwarding use Redis keys and pub/sub.

## 3) Key Data Flows
### Single `.chk`
1) guardInput → parseCredentials → checkCredentials
2) HTTP flow: navigate → email step (POW) → password step (POW) → detectOutcome
3) On VALID: captureAccountData → buildCheckAndCaptureResult → channel forward (dedup via `channelForwardStore`)

### Regular Batch
1) Upload file → batch handler parses → filterAlreadyProcessed (MGET)
2) `setTimeout(...,0)` to detach → chunked processing with `BATCH_CONCURRENCY`
3) markProcessedStatus buffered; updateProgress throttled; summary with valid creds

### Combine Batch
1) `/combine` collect files → `/done` download/parse/dedupe → choose type
2) Confirm → runCombineBatch (or coordinator queue in distributed combine) via `setTimeout`
3) Progress + summary similar to regular batch

### Distributed Queue
- Coordinator: `JobQueueManager.enqueueBatch` → tasks in Redis; `ProgressTracker.initBatch/startTracking` edits Telegram; `ChannelForwarder` listens to pub/sub `forward_events`.
- Worker: `WorkerNode` pops tasks, increments progress, publishes forward/update events.

## 4) Storage & Dedup
- **Processed creds**: `processedStore` (`proc:{user}:{pass}`), 30-day TTL, Redis-only.
- **Forwarded creds**: `channelForwardStore` (`fwd:{user}:{pass}`), 30-day TTL, shared by single + distributed forwarders.
- **Message tracking**: `messageTracker` (`msg:{trackingCode}`, `msg:cred:{user}:{pass}`) for delete/update.

## 5) Telegram Patterns
- Always use `{ parse_mode: 'MarkdownV2' }` and helpers from `telegram/messages/helpers.js`: `escapeV2`, `codeV2`, `boldV2`, `spoilerCodeV2`. (Distributed `ChannelForwarder` uses local copies for its formatter.)
- Long work inside callbacks must be wrapped with `setTimeout(() => runAsync(), 0)` to avoid Telegraf timeout.
- Progress throttling lives in `ProgressTracker` (distributed) and batch runners (single/combine).

## 6) HTTP Flow Highlights
- POW (`cres`) from `/util/gc` mdata {mask,key,seed}; computed via `src/shared/fingerprinting/challengeGenerator.js` (native murmur if available, worker pool + cache; see also `powServiceClient`, `powWorker`, `powCache`, `powWorkerPool`).
- Proxy support: multiple URI/colon forms handled in `httpClient.parseProxy`.
- Capture requirements for forwarding: latest order present and at least one card (`capture.profile.cards.length > 0`).

## 7) Environment Cheatsheet

**Coordinator required**: `TELEGRAM_BOT_TOKEN`, `TARGET_LOGIN_URL`, `REDIS_URL`

**Worker required**: `REDIS_URL`

**Common**: `REDIS_URL`, `TARGET_LOGIN_URL`, `LOG_LEVEL`, `TIMEOUT_MS`, `REDIS_COMMAND_TIMEOUT`

**Coordinator optional**: `FORWARD_CHANNEL_ID`, `ALLOWED_USER_IDS`, `METRICS_PORT` (9090), `BATCH_CONCURRENCY`, `BATCH_DELAY_MS`, `BATCH_MAX_RETRIES`, `BATCH_HUMAN_DELAY_MS`, `PROXY_SERVER`, `PROXY_POOL`, `PROCESSED_TTL_MS`, `FORWARD_TTL_MS`

**Worker optional**: `WORKER_ID` (auto), `WORKER_CONCURRENCY` (3), `WORKER_TASK_TIMEOUT` (120000), `WORKER_HEARTBEAT_INTERVAL` (10000), `WORKER_QUEUE_TIMEOUT` (30000), `POW_SERVICE_URL`

**POW Service optional**: `PORT` (3001), `POW_NUM_WORKERS` (auto = CPU-1), `POW_TASK_TIMEOUT` (30000), `REDIS_URL` (for caching)

See `docs/ENVIRONMENT.md` for the full reference.

## 8) Reliability & Shutdown
- Graceful shutdown waits (up to 5m) for active regular + combine batches; flushes write buffer; closes Redis; stops bot.
- In coordinator mode, progress/summaries use `ProgressTracker.sendSummary`; channel forwards dedup before send.

## 9) Common Issues
- Bot stops responding after heavy callback: ensure heavy work is detached with `setTimeout` and errors are caught (`bot.catch`, polling_error handlers).
- Duplicate channel forwards: verify `channelForwardStore` is consulted (single) and `src/coordinator/ChannelForwarder` marks/reads the same store.
- Missing summaries in distributed mode: check `ProgressTracker` throttle vs completion path; summaries send immediately when `completed >= total`.

## 10) Quick How-Tos
- Add Telegram command: register in `src/telegram/telegramHandler.js`, update help text if needed.
- Add batch type: add filter in `src/shared/batch/parse.js`, add handler under `src/telegram/batch/handlers/`, register in `src/telegram/batch/index.js`, wire button in `src/telegram/batch/documentHandler.js`.
- Modify login flow: edit `src/shared/http/flow.js` + payloads; adjust `htmlAnalyzer` detection; test with LOG_LEVEL=debug.
- Extend capture: add module under `src/shared/capture/` and include in orchestrator; update message builder.
- Wire /status in coordinator mode: call `registerStatusHandler(bot, coordinator)` in `src/telegram/telegramHandler.js` when coordinator is available.


