# Rakuten Telegram Credential Checker — AI Agent Entry Point

Distributed Node.js/Docker system for validating Rakuten account credentials via Telegram. Architecture: Coordinator + Worker(s) + PoW Service + Redis + Telegram bot.

## What to Read First

| Topic | Doc |
|-------|-----|
| Architecture & services | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Deep data flows & storage | [AI_CONTEXT.md](AI_CONTEXT.md) |
| Shared modules (config, HTTP, Redis, etc.) | [docs/SHARED_MODULES.md](docs/SHARED_MODULES.md) |
| Environment variables | [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) |
| Centralized config system | [docs/CONFIG_SYSTEM.md](docs/CONFIG_SYSTEM.md) |
| Testing (local harness + integration) | [docs/TESTING.md](docs/TESTING.md) |
| Deployment (AWS setup) | [docs/AWS_SETUP.md](docs/AWS_SETUP.md) |
| Operations (update scripts) | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| PoW service API | [docs/POW_SERVICE.md](docs/POW_SERVICE.md) |

## Rules

- **Production is coordination-mode-only**: Coordinator (Telegram + queue), Workers, PoW Service, Redis. No single-node production mode.
- **Never reintroduce**: `SingleNodeMode`, JSONL/`processed.jsonl` fallback, old root bridge files, legacy `automation/`/`shared/`/`telegram/`/`utils/` folders, compatibility layer.
- **Telegram**: Always use `{ parse_mode: 'MarkdownV2' }` with `escapeV2`/`codeV2`/`boldV2` helpers. Wrap long callback work in `setTimeout(() => ..., 0)` to avoid Telegraf timeouts.
- **Redis**: All keys defined in `src/shared/redis/keys.js`. Dedup via `processedStore` (processed creds) and `channelForwardStore` (forwarded creds). No JSONL fallback.
- **Shutdown**: Close sessions (`.chk`) and Redis connections on all code paths. Graceful shutdown waits up to 5 minutes for active batches.
- **Dependencies**: Do not upgrade without explicit instruction. Do not add unrelated features.

## How to Validate Changes

1. Syntax check: `node -c src/path/to/file.js`
2. Local full-flow test: `npm run test:flow` (exercises production modules in a single process)
3. Config system test: `npm run test:config` (schema validation + Redis ops + pub/sub)
4. Integration tests: `npm run test:integration` (requires Redis)
5. Verify changed module with `LOG_LEVEL=debug` for HTTP flow output
6. Grep the codebase for stale references to removed patterns
