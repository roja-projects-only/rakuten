# Shared Modules

## Overview

All shared modules live under `src/shared/` and are used by multiple services. They provide common functionality like configuration, logging, Redis, HTTP, batch processing, and more.

## Config Module

**Location**: `src/shared/config/`  
**Purpose**: Environment validation and centralized config service

### Files
- `environment.js` — Mode detection + env var validation
- `configService.js` — Centralized config with Redis pub/sub hot-reload
- `configSchema.js` — Schema: 20 hot-reloadable variables with type/range validation

### Who Imports It
- Coordinator, Worker, POW Service (environment validation)
- Telegram handlers (config commands)
- Batch executors (config values)

### Rules for Modifying
- Always validate new env vars in `environment.js`
- Add new config keys to `configSchema.js` with type/range validation
- Test hot-reload propagation across services

---

## Logger Module

**Location**: `src/shared/logger/`  
**Purpose**: Unified logging with human-friendly and JSON output modes

### Files
- `logger.js` — Unified logger, single entry point: `createLogger(scope)`. Supports both human (ANSI colored, single-line) and JSON (single-line) output modes controlled by `LOG_FORMAT` env var.
- `structured.js` — Thin compatibility wrapper: `createStructuredLogger(scope)` delegates to `createLogger()` and adds task-specific helpers. Importing from here is functionally equivalent to using `createLogger()` directly.

### Who Imports It
- All modules in `src/shared/`, `src/coordinator/`, `src/worker/`, `src/pow-service/`, `src/telegram/`

### Rules for Modifying
- Use `createLogger('scope')` pattern for new modules; `createStructuredLogger()` is available but not required for new code.
- Log levels: error, warn, info, debug, trace
- `LOG_LEVEL` is read per-call — runtime changes via the config service apply immediately (no restart required).
- JSON output format: `{"timestamp","level","scope","message", ...context, "process":{pid,hostname,nodeVersion}}`. All levels go to stdout. Human mode sends error/warn to stderr, rest to stdout.
- No `console.log` in runtime code — use logger module

---

## Redis Module

**Location**: `src/shared/redis/`  
**Purpose**: Redis client and key schema

### Files
- `client.js` — ioredis wrapper with connection pooling, retry, health monitoring
- `keys.js` — Centralized Redis key schema (325 lines)

### Who Imports It
- Coordinator (job queue, progress tracking, channel forwarding)
- Worker (task dequeue, result storage)
- POW Service (caching)
- Telegram handlers (dedupe stores)

### Rules for Modifying
- New Redis keys should be defined in `keys.js`. Note: the two dedup stores predate the schema and still define their own prefixes locally — `processedStore.js` (`proc:` prefix) and `channelForwardStore.js` (`fwd:` prefix). All other keys live in `keys.js`.
- Use `REDIS_URL` for connection (required for coordinator/worker)
- Test key patterns with `redis-cli`

---

## HTTP Module

**Location**: `src/shared/http/`  
**Purpose**: HTTP client, flow, analyzer, checker

### Files
- `checker.js` — Credential checker (main entry point)
- `client.js` — Axios client with cookie jar, proxy support
- `flow.js` — Login flow (navigate → email → password → detect outcome)
- `analyzer.js` — Response outcome detection
- `sessionManager.js` — Session lifecycle management
- `ipFetcher.js` — Exit IP detection
- `retryInterceptor.js` — HTTP retry logic
- `proxyTracker.js` — Proxy redirect handling

### Who Imports It
- Coordinator (`.chk` commands)
- Worker (task execution)
- Telegram handlers (single checks)

### Rules for Modifying
- Test login flow with `LOG_LEVEL=debug`
- Update `analyzer.js` when Rakuten changes response patterns
- Test proxy support with different proxy formats

---

## Batch Module

**Location**: `src/shared/batch/`  
**Purpose**: Batch processing, parsing, processed store

### Files
- `index.js` — Barrel export
- `parse.js` — File parsing, type filters (hotmail/ulp/jp/all)
- `processedStore.js` — Redis-only dedup cache with 30-day TTL
- `processor.js` — Batch result processing
- `constants.js` — Domain lists, size limits
- `hotmail.js` — HOTMAIL batch preparation
- `ulp.js` — ULP batch preparation
- `http.js` — HTTP batch utilities

### Who Imports It
- Telegram batch handlers
- Worker (task execution)
- Coordinator (progress tracking)

### Rules for Modifying
- Redis is required — no JSONL fallback
- Test domain filters with sample credential files
- Update `constants.js` for new domain patterns

---

## Fingerprinting Module

**Location**: `src/shared/fingerprinting/`  
**Purpose**: POW challenge, bio/rat generators

### Files
- `challengeGenerator.js` — POW algorithm (murmurhash)
- `powServiceClient.js` — POW service HTTP client
- `powWorkerPool.js` — Worker thread pool
- `powWorker.js` — Worker thread script
- `powCache.js` — POW cache
- `bioGenerator.js` — Behavioral biometrics
- `ratGenerator.js` — RAT fingerprint
- `browserProfile.js` — Browser fingerprint profile

### Who Imports It
- HTTP flow (POW computation)
- POW Service (computation)

### Rules for Modifying
- Test POW algorithm with known mask/key/seed combinations
- Update `powServiceClient.js` for POW service API changes
- Test fallback to local computation

---

## Capture Module

**Location**: `src/shared/capture/`  
**Purpose**: Account data capture

### Files
- `index.js` — Capture orchestrator
- `apiCapture.js` — API-based capture
- `htmlCapture.js` — HTML fallback
- `orderHistory.js` — Order data
- `profileData.js` — Profile and cards
- `ssoFormHandler.js` — SSO handler
- `validateCaptureForForwarding.js` — Forwarding eligibility check (latest order + ≥1 card)

### Who Imports It
- HTTP flow (after successful login)
- Telegram handlers (capture messages)

### Rules for Modifying
- Test capture with valid credentials
- Update API endpoints when Rakuten changes APIs
- Test both API and HTML capture paths

---

## Payloads Module

**Location**: `src/shared/payloads/`  
**Purpose**: Request payloads

### Files
- `authorizeRequest.js` — Auth payload
- `bioPayload.js` — Bio payload
- `ratPayload.js` — RAT payload

### Who Imports It
- HTTP flow (login requests)

### Rules for Modifying
- Test payload generation with known inputs
- Update payloads when Rakuten changes request formats

---

## Errors Module

**Location**: `src/shared/errors/`  
**Purpose**: Custom error classes

### Files
- `index.js` — Barrel export
- `AppError.js` — Base error class
- `RetryableError.js` — Transient failures
- `TimeoutError.js` — Operation timeouts
- `ValidationError.js` — Input validation

### Who Imports It
- HTTP flow (error handling)
- Batch processing (error handling)
- Telegram handlers (error messages)

### Rules for Modifying
- Use custom error classes for specific error types
- Test error handling paths

---

## Constants Module

**Location**: `src/shared/constants/`  
**Purpose**: Shared constants

### Files
- `index.js` — Barrel export
- `statusCodes.js` — Credential status codes, batch states
- `defaults.js` — TTL defaults, key prefixes

### Who Imports It
- All modules that need status codes or defaults

### Rules for Modifying
- Update status codes when adding new credential states
- Test constant usage across modules

---

## Utils Module

**Location**: `src/shared/utils/`  
**Purpose**: Utility functions

### Files
- `retryWithBackoff.js` — Generic exponential backoff retry with jitter
- `mapWithTtl.js` — TTL-based in-memory Map with auto-cleanup

### Who Imports It
- HTTP flow (retry logic)
- Batch processing (retry logic)
- Various modules (TTL map)

### Rules for Modifying
- Test retry logic with different backoff strategies
- Test TTL map with different TTL values
