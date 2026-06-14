# Architecture

## Overview

The Rakuten Telegram Credential Checker is a distributed system for validating Rakuten account credentials. It uses a coordinator/worker architecture with Redis for task queuing and coordination.

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Coordinator   │    │   POW Service   │    │     Redis       │
│  (Telegram Bot) │◄──►│ (Proof of Work) │    │ (Coordination)  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                                              ▲
         ▼                                              │
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│    Worker 1     │    │    Worker 2     │    │    Worker N     │
│ (Credential     │    │ (Credential     │    │ (Credential     │
│  Checking)      │    │  Checking)      │    │  Checking)      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## Service Boundaries

### Coordinator Service
- **Owns**: Telegram bot, job orchestration, progress tracking, channel forwarding
- **Depends on**: Redis, shared modules
- **Does NOT own**: credential checking logic, POW computation
- **Entry**: `src/coordinator/index.js`

### Worker Service
- **Owns**: Task execution, credential checking
- **Depends on**: Redis, shared modules, HTTP checker
- **Does NOT own**: Telegram bot, job queue management
- **Entry**: `src/worker/index.js`

### POW Service
- **Owns**: POW computation, caching
- **Depends on**: Redis (optional), shared modules
- **Does NOT own**: credential checking, Telegram bot
- **Entry**: `src/pow-service/index.js`

### Shared Modules
- **Config**: environment validation, config service, schema
- **Logger**: structured logging
- **Redis**: client, keys
- **HTTP**: client, session manager, flow, analyzer
- **Batch**: parsing, processed store, constants
- **Fingerprinting**: challenge generator, POW client
- **Capture**: API capture, HTML capture, profile data
- **Utils**: retry, TTL map, error classes
- **Constants**: status codes, key prefixes, defaults

## Data Flow

### Single Credential Check
1. Telegram → Coordinator parses `.chk` command
2. Coordinator → HTTP checker flow (navigate → email step → password step → detect outcome)
3. On VALID: capture account data → build result → channel forward (dedup via `channelForwardStore`)

### Batch Processing
1. Upload file → batch handler parses → filter already processed (MGET)
2. `setTimeout(...,0)` to detach → chunked processing with `BATCH_CONCURRENCY`
3. `markProcessedStatus` buffered; `updateProgress` throttled; summary with valid creds

### Distributed Queue
- **Coordinator**: `JobQueueManager.enqueueBatch` → tasks in Redis; `ProgressTracker.initBatch/startTracking` edits Telegram; `ChannelForwarder` listens to pub/sub `forward_events`.
- **Worker**: `WorkerNode` pops tasks, increments progress, publishes forward/update events.

## Redis Design

Redis serves as the single source of truth for:

| Purpose | Key Pattern | TTL |
|---------|-------------|-----|
| Task queue | `queue:tasks`, `queue:retry` | None |
| Progress tracking | `progress:{batchId}` | None |
| Processed credentials | `proc:{user}:{pass}` | 30 days |
| Channel forward dedup | `fwd:{user}:{pass}` | 30 days |
| Worker heartbeats | `worker:{id}:heartbeat` | 30s |
| Coordinator heartbeat | `coordinator:heartbeat` | 30s |
| Config values | `config:{key}` | None |
| Message tracking | `msg:{trackingCode}` | 30 days |

## Telegram Flow

1. Bot receives message → `telegramHandler.js` routes to command handler
2. `.chk` → `checkCredentials` → HTTP flow → result message
3. File upload → batch handler → parse → filter → queue to Redis
4. `/config` → config handler → get/set/reset config values
5. `/export` → export handler → send VALID credentials as file
6. `/status` → status handler → show system health

## POW Flow

1. HTTP flow needs POW computation → `powServiceClient.computeCres()`
2. Client sends POST to POW service `/compute` endpoint
3. POW service computes using worker threads → returns result
4. If POW service unavailable → fallback to local computation
5. Results cached in Redis (POW service) or memory (local fallback)

## Module Dependency Rules

- Services (`src/coordinator/`, `src/worker/`, `src/pow-service/`) can import from `src/shared/`
- Services can import from `src/telegram/` (coordinator only)
- `src/shared/` modules cannot import from services
- `src/telegram/` modules can import from `src/shared/`
- No circular dependencies between modules
