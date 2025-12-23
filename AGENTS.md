Default shell is PowerShell (Windows). Always quote paths with the apostrophe in the username, e.g., "C:\Users\Core'\...".
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
- HTTP checker: `httpChecker.js`
- Batch UX: `telegram/batchHandlers.js`
- Combine UX: `telegram/combineHandler.js`, `telegram/combineBatchRunner.js`
- Channel forwarding: `telegram/channelForwarder.js` (single) and `shared/coordinator/ChannelForwarder.js` (distributed)
- Progress tracking: `shared/coordinator/ProgressTracker.js`

## Critical Patterns
- For long work in Telegram callbacks, wrap with `setTimeout(() => { ... }, 0)` to avoid Telegraf timeouts.
- Always use `parse_mode: 'MarkdownV2'` with `escapeV2/codeV2/boldV2` helpers.
- Close sessions (`closeSession`) in `.chk` even on errors.
- Use Redis-backed dedupe: `processedStore` for processed creds, `channelForwardStore` for forwarded creds.

## Common Commands
- `.chk user:pass` — single check (auto capture on VALID).
- `/stop` — abort active batch/combine; in coordinator mode cancels via progress tracker.
- `/combine` → upload files → `/done` → choose type → confirm.

## Deployment Notes
- Required env: `TELEGRAM_BOT_TOKEN`, `TARGET_LOGIN_URL`; add `REDIS_URL` for distributed.
- Graceful shutdown waits for active batches; max 5 minutes.

## Troubleshooting
- Bot unresponsive after batch: ensure batch runners are detached with `setTimeout`.
- Duplicate channel forwards: dedupe via `channelForwardStore` (both single and distributed).
- No final summary in coordinator mode: check `ProgressTracker.sendSummary` path and throttle settings.

See [AI_CONTEXT.md](AI_CONTEXT.md) for deep architecture and data-flow details.
