# Rakuten Credential Checker — AI Context

Use this as the deep reference for the current workspace. For quick rules, see [AGENTS.md](AGENTS.md).

## 1) Architecture Map
```
main.js                       # Bootstrap, env validation, shutdown
telegramHandler.js            # Telegram bot setup, commands, callbacks
telegram/messages/            # MarkdownV2 helpers + builders
telegram/batchHandlers.js     # Regular batch UX
telegram/combineHandler.js    # Combine mode UX (/combine → /done)
telegram/combineBatchRunner.js# Combine batch execution (setTimeout wrapper)
telegram/channelForwarder.js  # Single-node channel forward dedupe
shared/coordinator/*          # Distributed coordinator, job queue, progress, forwarding
shared/worker/WorkerNode.js   # Worker execution loop
httpChecker.js                # HTTP login/check entry
automation/http/*             # HTTP flows, capture, session, IP fetch
automation/batch/processedStore.js # Processed cache (Redis/JSONL)
telegram/channelForwardStore.js    # Forward dedupe (Redis/JSONL)
telegram/messageTracker.js    # Forwarded message tracking for updates
```

## 2) Modes
- **Single-node**: `.chk` and batches run inline.
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
- **Processed creds**: `processedStore` (`proc:{user}:{pass}`), 30-day TTL, Redis or JSONL fallback.
- **Forwarded creds**: `channelForwardStore` (`fwd:{user}:{pass}`), 30-day TTL, shared by single + distributed forwarders.
- **Message tracking**: `messageTracker` (`msg:{trackingCode}`, `msg:cred:{user}:{pass}`) for delete/update.

## 5) Telegram Patterns
- Always use `{ parse_mode: 'MarkdownV2' }` and helpers `escapeV2/codeV2/boldV2/spoilerCodeV2`.
- Long work inside callbacks must be wrapped with `setTimeout(() => runAsync(), 0)` to avoid Telegraf timeout.
- Progress throttling lives in `ProgressTracker` (distributed) and batch runners (single/combine).

## 6) HTTP Flow Highlights
- POW (`cres`) from `/util/gc` mdata {mask,key,seed}; computed via challengeGenerator (native murmur if available, worker pool + cache).
- Proxy support: multiple URI/colon forms handled in `httpClient.parseProxy`.
- Capture requirements for forwarding: latest order present and at least one card (`capture.profile.cards.length > 0`).

## 7) Environment Cheatsheet
Required: `TELEGRAM_BOT_TOKEN`, `TARGET_LOGIN_URL`
Common: `REDIS_URL`, `PROXY_SERVER`, `BATCH_CONCURRENCY`, `BATCH_DELAY_MS`, `BATCH_MAX_RETRIES`, `BATCH_HUMAN_DELAY_MS`, `FORWARD_CHANNEL_ID`, `LOG_LEVEL`, `TIMEOUT_MS`

## 8) Reliability & Shutdown
- Graceful shutdown waits (up to 5m) for active regular + combine batches; flushes write buffer; closes Redis; stops bot.
- In coordinator mode, progress/summaries use `ProgressTracker.sendSummary`; channel forwards dedup before send.

## 9) Common Issues
- Bot stops responding after heavy callback: ensure heavy work is detached with `setTimeout` and errors are caught (`bot.catch`, polling_error handlers).
- Duplicate channel forwards: verify `channelForwardStore` is consulted (single) and `shared/coordinator/ChannelForwarder` marks/reads the same store.
- Missing summaries in distributed mode: check `ProgressTracker` throttle vs completion path; summaries send immediately when `completed >= total`.

## 10) Quick How-Tos
- Add Telegram command: register in `telegramHandler.js`, update help text if needed.
- Add batch type: add filter in `automation/batch/parse.js`, handler under `telegram/batch/handlers/`, wire button in `documentHandler`.
- Modify login flow: edit `automation/http/httpFlow.js` + payloads; adjust `htmlAnalyzer` detection; test with LOG_LEVEL=debug.
- Extend capture: add module under `automation/http/capture/` and include in orchestrator; update message builder.


