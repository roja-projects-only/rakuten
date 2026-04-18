Commit locally after each task (no push unless asked). Do not generate extra docs unless requested.

# Rakuten Telegram Credential Checker — Agent Playbook

## Quick Start
- Install deps: `npm install`
- Run bot: `npm start`
- Debug logging: `$env:LOG_LEVEL="debug"; npm start`

## Modes
- Single-node: processes batches inline.
- Coordinator/worker: coordinator queues tasks to Redis; workers execute.

## Key Entry Points
- App bootstrap: `main.js`
- Telegram bot: `telegramHandler.js`
- Worker entry: `worker.js`
- POW service: `pow-service.js` (HTTP on port 3001, mapped to host 8080)
- HTTP checker: `httpChecker.js`
- Batch UX: `telegram/batchHandlers.js` → `telegram/batch/index.js`, `telegram/batch/documentHandler.js`
- Batch execution: `telegram/batch/batchExecutor.js` (progress/retries), `telegram/batch/circuitBreaker.js` (auto-pause)
- Combine UX: `telegram/combineHandler.js`, `telegram/combineBatchRunner.js`
- Channel forwarding: `telegram/channelForwarder.js` (single) and `shared/coordinator/ChannelForwarder.js` (distributed)
- Progress tracking: `shared/coordinator/ProgressTracker.js`
- Config/export: `telegram/configHandler.js`, `telegram/exportHandler.js`; `/status`: `telegram/statusHandler.js` (wire with coordinator when distributed)
- Compatibility: `shared/compatibility/` — `GracefulDegradation.js`, `SingleNodeMode.js` (fallback when Redis unavailable)

## Critical Patterns
- For long work in Telegram callbacks, wrap with `setTimeout(() => { ... }, 0)` to avoid Telegraf timeouts.
- Always use `parse_mode: 'MarkdownV2'` with `escapeV2/codeV2/boldV2` helpers.
- Close sessions (`closeSession`) in `.chk` even on errors.
- Use Redis-backed dedupe: `processedStore` for processed creds, `channelForwardStore` for forwarded creds.

## Common Commands
- `/start` — welcome message with quick-action buttons (Check Now, Guide, Help).
- `.chk user:pass` — single check (auto capture on VALID).
- `.proxy` — show current proxy status.
- `.ulp <url>` — process ULP data from URL instead of file upload.
- `/stop` — abort active batch/combine; in coordinator mode cancels via progress tracker.
- `/combine` → upload files → `/done` → choose type → confirm.
- `/config` — view/set centralized config (when config service initialized).
- `/export` — export VALID creds via export handler (Telegram).
- `/status` — system health (when `registerStatusHandler(bot, coordinator)` is wired in coordinator mode).

## Deployment Notes
- Required env: `TELEGRAM_BOT_TOKEN`, `TARGET_LOGIN_URL`; add `REDIS_URL` for distributed.
- Coordinator: `COORDINATOR_MODE=true`, exposes port 9090 (metrics).
- Worker: `WORKER_CONCURRENCY` (default 3), `POW_SERVICE_URL`, `WORKER_TASK_TIMEOUT`.
- POW service: internal port 3001, mapped to host 8080 (`-p 8080:3001`).
- Dockerfiles use `--chown` on COPY (no `RUN chown -R`); npm install layer cached across code changes.
- Fast deploy: `scripts/deploy/quick-update.sh <service> --fast` (docker cp + restart, ~5s).
- Full rebuild: `scripts/deploy/quick-update.sh <service>` (docker build cycle).
- Graceful shutdown waits for active batches; max 5 minutes.
- See `docs/AWS_SETUP_GUIDE.md` for full AWS deployment walkthrough.

## Troubleshooting
- Bot unresponsive after batch: ensure batch runners are detached with `setTimeout`.
- Duplicate channel forwards: dedupe via `channelForwardStore` (both single and distributed).
- No final summary in coordinator mode: check `ProgressTracker.sendSummary` path and throttle settings.

See [AI_CONTEXT.md](AI_CONTEXT.md) for deep architecture and data-flow details.
