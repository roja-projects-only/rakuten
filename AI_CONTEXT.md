# Rakuten Credential Checker — AI Context Reference

> Comprehensive reference for AI agents working on this codebase. For quick reference, see `AGENTS.md`.

---

## Table of Contents
1. [System Architecture](#system-architecture)
2. [Module Reference](#module-reference)
3. [Data Flow Diagrams](#data-flow-diagrams)
4. [Telegram Bot Interface](#telegram-bot-interface)
5. [Batch Processing System](#batch-processing-system)
6. [HTTP Authentication Flow](#http-authentication-flow)
7. [Redis & Storage Layer](#redis--storage-layer)
8. [Performance Optimizations](#performance-optimizations)
9. [Error Handling Patterns](#error-handling-patterns)
10. [Deployment & Shutdown](#deployment--shutdown)
11. [Common Issues & Solutions](#common-issues--solutions)

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         TELEGRAM LAYER                               │
├─────────────────────────────────────────────────────────────────────┤
│  main.js              → Bootstrap, env validation, graceful shutdown │
│  telegramHandler.js   → Command routing, input validation            │
│  telegram/messages.js → MarkdownV2 formatters                        │
├─────────────────────────────────────────────────────────────────────┤
│                         BATCH LAYER                                  │
├─────────────────────────────────────────────────────────────────────┤
│  telegram/batchHandlers.js     → Regular batch (file upload)         │
│  telegram/combineHandler.js    → Combine mode session management     │
│  telegram/combineBatchRunner.js→ Combine batch execution             │
├─────────────────────────────────────────────────────────────────────┤
│                         HTTP LAYER                                   │
├─────────────────────────────────────────────────────────────────────┤
│  httpChecker.js                → Entry point for credential checks   │
│  automation/http/httpFlow.js   → Login flow orchestration            │
│  automation/http/httpClient.js → Axios client with cookie jar        │
│  automation/http/htmlAnalyzer.js → Outcome detection                 │
│  automation/http/httpDataCapture.js → Account data extraction        │
│  automation/http/sessionManager.js  → Session lifecycle              │
├─────────────────────────────────────────────────────────────────────┤
│                      FINGERPRINTING LAYER                            │
├─────────────────────────────────────────────────────────────────────┤
│  fingerprinting/challengeGenerator.js → POW cres computation         │
│  fingerprinting/powWorkerPool.js      → Multi-threaded POW           │
│  fingerprinting/powCache.js           → POW result caching           │
│  fingerprinting/bioGenerator.js       → Human behavior simulation    │
│  fingerprinting/ratGenerator.js       → Browser fingerprint data     │
├─────────────────────────────────────────────────────────────────────┤
│                         STORAGE LAYER                                │
├─────────────────────────────────────────────────────────────────────┤
│  automation/batch/processedStore.js → Redis/JSONL processed cache    │
│  automation/batch/parse.js          → Credential parsing             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Module Reference

### Entry Points

| File | Purpose | Key Exports |
|------|---------|-------------|
| `main.js` | Application bootstrap | N/A (entry point) |
| `telegramHandler.js` | Telegram bot setup | `initializeTelegramHandler()` |
| `httpChecker.js` | Credential checking | `checkCredentials(email, password, options)` |

### Telegram Layer

| File | Purpose | Key Exports |
|------|---------|-------------|
| `telegram/messages.js` | MarkdownV2 message builders | `escapeV2`, `codeV2`, `boldV2`, `spoilerV2`, `spoilerCodeV2`, `formatBytes`, `formatDurationMs` |
| `telegram/batchHandlers.js` | Regular batch processing | `registerBatchHandlers()`, `abortActiveBatch()`, `hasActiveBatch()`, `getAllActiveBatches()` |
| `telegram/combineHandler.js` | Combine mode session | `registerCombineHandlers()`, `hasSession()`, `clearSession()` |
| `telegram/combineBatchRunner.js` | Combine batch execution | `runCombineBatch()`, `abortCombineBatch()`, `hasCombineBatch()`, `getActiveCombineBatch()` |

### HTTP Layer

| File | Purpose | Key Exports |
|------|---------|-------------|
| `automation/http/httpFlow.js` | Login flow steps | `navigateToLogin()`, `submitEmailStep()`, `submitPasswordStep()` |
| `automation/http/httpClient.js` | HTTP client factory | `createHttpClient()`, `parseProxy()` |
| `automation/http/htmlAnalyzer.js` | Response analysis | `detectOutcome()`, `isRedirect()`, `getRedirectUrl()` |
| `automation/http/httpDataCapture.js` | Account data capture | `captureAccountData(session)` |
| `automation/http/sessionManager.js` | Session lifecycle | `createSession()`, `closeSession()`, `touchSession()` |

### Storage Layer

| File | Purpose | Key Exports |
|------|---------|-------------|
| `automation/batch/processedStore.js` | Processed credentials cache | `initProcessedStore()`, `getProcessedStatusBatch()`, `markProcessedStatus()`, `flushWriteBuffer()` |
| `automation/batch/parse.js` | Credential parsing | `parseColonCredential()`, `isAllowedHotmailUser()` |

---

## Data Flow Diagrams

### Single Credential Check
```
User: .chk email:pass
       ↓
telegramHandler.js
  ├─ guardInput() → validate format
  ├─ parseCredentials() → split email:pass
  └─ checkCredentials()
       ↓
httpChecker.js
  ├─ createSession({ batchMode: false })
  ├─ navigateToLogin() → GET login page, POST /v2/login
  ├─ submitEmailStep() → /util/gc (POW), POST /v2/login/start
  ├─ submitPasswordStep() → /util/gc (POW), POST /v2/login/complete
  ├─ detectOutcome() → VALID/INVALID/BLOCKED/ERROR
  └─ if VALID: captureAccountData() → points, rank, cash
       ↓
User: Result message with captured data
```

### Batch Processing Flow
```
User: Upload file → Select type (HOTMAIL/ULP/JP/ALL) → Confirm
       ↓
batchHandlers.js
  ├─ prepareBatchFromFile() → parse credentials
  ├─ filterAlreadyProcessed() → Redis MGET batch lookup
  ├─ setTimeout(execute, 0) → detach from callback
  └─ processInChunks()
       ├─ for each chunk (size = BATCH_CONCURRENCY):
       │    ├─ Promise.all(chunk.map(checkCredentials))
       │    ├─ markProcessedStatus() → buffered Redis write
       │    └─ updateProgress() → edit Telegram message
       └─ finally: flushWriteBuffer() → pipeline flush
       ↓
User: Summary message with valid credentials
```

### Combine Mode Flow
```
User: /combine
       ↓
combineHandler.js
  └─ getOrCreateSession() → create combine session
       ↓
User: Upload files (1-20)
       ↓
batchHandlers.js (document handler)
  └─ if hasCombineSession(): addFileToSession()
       ↓
User: /done
       ↓
combineHandler.js
  ├─ processSessionFiles() → download & parse all files
  ├─ dedupeCredentials() → remove duplicates
  └─ show type selection buttons
       ↓
User: Select type → Confirm
       ↓
combineBatchRunner.js
  ├─ filterAlreadyProcessed() → Redis batch lookup
  ├─ setTimeout(async () => { ... }, 0) → async execution
  └─ processInChunks() → same as regular batch
       ↓
User: Summary message
```

---

## Telegram Bot Interface

### Commands

| Command | Handler | Description |
|---------|---------|-------------|
| `/start` | `telegramHandler.js` | Welcome message with buttons |
| `/help` | `telegramHandler.js` | Command reference |
| `/stop` | `telegramHandler.js` | Abort active batch or clear combine session |
| `/combine` | `combineHandler.js` | Start combine mode |
| `/done` | `combineHandler.js` | Finish adding files, show options |
| `/cancel` | `combineHandler.js` | Cancel combine session |
| `.chk email:pass` | `telegramHandler.js` | Single credential check |

### Callback Actions

| Pattern | Handler | Description |
|---------|---------|-------------|
| `batch_type_*` | `batchHandlers.js` | Select batch processing type |
| `batch_confirm_*` | `batchHandlers.js` | Start batch processing |
| `batch_abort_*` | `batchHandlers.js` | Abort running batch |
| `combine_type_*` | `combineHandler.js` | Select combine filter type |
| `combine_confirm_*` | `combineHandler.js` | Start combine batch |
| `combine_abort_*` | `combineHandler.js` | Abort combine batch |

### MarkdownV2 Formatting

All Telegram replies must use `{ parse_mode: 'MarkdownV2' }`. Use helpers from `telegram/messages.js`:
- `escapeV2(text)` — Escape special characters in user input
- `codeV2(text)` — Inline code: `` `text` ``
- `boldV2(text)` — Bold: `*text*`
- `spoilerV2(text)` — Spoiler: `||text||`
- `spoilerCodeV2(text)` — Spoiler + code for credentials

---

## Batch Processing System

### Batch Types

| Type | Filter | Use Case |
|------|--------|----------|
| HOTMAIL | `live.jp`, `hotmail.co.jp`, `hotmail.jp`, `outlook.jp`, `outlook.co.jp`, `msn.co.jp` | Microsoft Japan domains |
| ULP | Contains "rakuten" | Rakuten-specific emails |
| JP | Ends with `.jp` | Any Japanese domain |
| ALL | None | All valid credentials |

### Processing Configuration

| Env Variable | Default | Description |
|--------------|---------|-------------|
| `BATCH_CONCURRENCY` | 1 | Parallel credential checks |
| `BATCH_DELAY_MS` | 50 | Delay between chunks (ms) |
| `BATCH_HUMAN_DELAY_MS` | 0 | Human delay multiplier (0=disabled) |
| `BATCH_MAX_RETRIES` | 1 | Retries for ERROR status |

### Batch Mode Flag

When `batchMode: true` is passed to `checkCredentials()`:
- Human delays in `httpFlow.js` are skipped (controlled by `BATCH_HUMAN_DELAY_MS`)
- Session is tagged for debugging: `Session: sess_xxx [batch]`

### Circuit Breaker

Batch processing includes a circuit breaker:
- Window size: 5 recent results
- Threshold: 60% errors
- Pause duration: 3 seconds
- Resets after pause

### Critical Pattern: Async Scheduling

Batch execution MUST be scheduled with `setTimeout(execute, 0)` to avoid blocking Telegraf's 90-second callback timeout:

```javascript
// ✓ Correct - in batchHandlers.js and combineBatchRunner.js
setTimeout(async () => {
  // Long-running batch processing
}, 0);

// ✗ Wrong - will cause bot to become unresponsive
await runLongBatchDirectly();
```

---

## HTTP Authentication Flow

### Rakuten Login Steps

1. **Navigate** → GET login page, POST `/v2/login` (init session)
2. **Email Step** → POST `/util/gc` (get POW challenge), POST `/v2/login/start`
3. **Password Step** → POST `/util/gc` (get POW challenge), POST `/v2/login/complete`
4. **Session Align** → If VALID, POST to `sessionAlign` endpoint

### POW (Proof of Work) Algorithm

Rakuten uses a client-side POW challenge (`cres`):

1. Request `/util/gc` with RAT fingerprint data
2. Receive `mdata: { mask, key, seed }`
3. Compute `cres`:
   - Start with `key` + random padding to 16 chars
   - Hash with MurmurHash3_x64_128(string, seed)
   - Loop until hash starts with `mask`
   - Return the string as `cres`

### Outcome Detection

| HTTP Status | Response Content | Outcome |
|-------------|------------------|---------|
| 200 | `sessionAlign` in redirect | VALID |
| 401 | `errorCode: INVALID_AUTHORIZATION` | INVALID |
| 400 | Challenge/captcha keywords | BLOCKED |
| Any | Network error | ERROR |

### Proxy Support

`httpClient.js` accepts flexible proxy formats:
- `host:port`
- `host:port:user:pass`
- `user:pass@host:port`
- `http://host:port`
- `http://user:pass@host:port`
- `socks5://...`

---

## Redis & Storage Layer

### Backend Selection

`processedStore.js` automatically selects backend:
- If `REDIS_URL` is set → Redis backend
- Otherwise → JSONL file backend

### Redis Optimizations

#### Batch Lookup (MGET)
Instead of N individual GET calls, uses MGET in batches of 1000:
```
50,000 credentials → 50 MGET calls (not 50,000 GET calls)
```

#### Write Buffering (Pipeline)
Writes are buffered and flushed in batches:
- Buffer size: 100 writes
- Flush interval: 1 second
- Uses Redis pipeline for single round-trip

### Key Functions

| Function | Description |
|----------|-------------|
| `initProcessedStore()` | Initialize backend (call once) |
| `getProcessedStatusBatch(keys)` | Batch lookup with MGET |
| `markProcessedStatus(key, status)` | Buffered write |
| `flushWriteBuffer()` | Force flush pending writes |
| `closeStore()` | Flush and disconnect |

### Key Format

Redis keys use prefix `proc:` with format: `proc:email:password`

TTL: 7 days (configurable via `PROCESSED_TTL_MS`)

---

## Performance Optimizations

### POW Optimizations

| Optimization | Impact |
|--------------|--------|
| Native MurmurHash (`murmurhash-native`) | ~10x faster than pure JS |
| Worker Thread Pool (`powWorkerPool.js`) | Parallel POW on multiple cores |
| POW Cache (`powCache.js`) | Skip recomputation for same challenges |
| Async API (`computeCresFromMdataAsync`) | Non-blocking for batch processing |

### Batch Speed Optimizations

| Optimization | Before | After |
|--------------|--------|-------|
| Human delays | 2-4s per cred | 0s (batch mode) |
| Chunk delay | 500ms | 50ms |
| Redis reads | N individual calls | N/1000 MGET batches |
| Redis writes | N individual calls | N/100 pipeline batches |

### Expected Throughput

With `BATCH_CONCURRENCY=3` and `BATCH_HUMAN_DELAY_MS=0`:
- ~2.5-3 credentials/second
- 50K credentials in ~4-5 hours

---

## Error Handling Patterns

### Logging

Use the logger module, not `console.log`:
```javascript
const { createLogger } = require('./logger');
const log = createLogger('module-name');

log.debug('Detailed info');  // Only when LOG_LEVEL=debug
log.info('Normal info');
log.warn('Warning');
log.error('Error');
log.success('Success');       // Green checkmark
```

### Graceful Error Handling

```javascript
// Pattern: Swallow non-critical errors with logging
markProcessedStatus(key, status).catch(() => {});

// Pattern: Swallow Telegram edit failures
try {
  await ctx.telegram.editMessageText(...);
} catch (err) {
  if (!err.message?.includes('message is not modified')) {
    log.debug(`Edit failed: ${err.message}`);
  }
}
```

### Batch Error Recovery

- Each credential is saved immediately after checking
- Retries for ERROR status (configurable)
- Circuit breaker pauses on high error rate
- Summary shows final counts even on abort

---

## Deployment & Shutdown

### Graceful Shutdown Sequence

When SIGTERM is received (Railway deployment):

1. Detect active batches (regular + combine)
2. Log progress every 10 seconds
3. Wait up to 5 minutes for completion
4. Flush Redis write buffer
5. Close Redis connection
6. Stop Telegram bot
7. Exit

### What's Preserved on Restart

| Preserved | Not Preserved |
|-----------|---------------|
| ✅ Checked credentials (Redis) | ❌ In-flight credentials at timeout |
| ✅ Valid credentials list | ❌ Progress message state |
| ✅ Final summary | ❌ Combine session files |

### Railway Configuration

- Builder: Nixpacks
- Auto-restart on failure
- Native deps build on Linux
- Required vars: `TELEGRAM_BOT_TOKEN`, `TARGET_LOGIN_URL`, `REDIS_URL`

---

## Common Issues & Solutions

### Bot Unresponsive After Batch

**Cause**: Batch running synchronously in Telegraf callback
**Solution**: Use `setTimeout(execute, 0)` pattern

### Slow Batch Processing

**Cause**: Human delays enabled, high chunk delay
**Solution**: Set `BATCH_HUMAN_DELAY_MS=0`, `BATCH_DELAY_MS=50`

### Redis Filtering Too Slow

**Cause**: Individual GET calls for each credential
**Solution**: Use `getProcessedStatusBatch()` with MGET

### POW Computation Slow

**Cause**: Single-threaded, no caching
**Solution**: Worker pool + cache enabled by default

### Combine Batch Hangs

**Cause**: Missing `processed` field update, no abort timeout
**Solution**: Update `batchData.processed`, add timeout to abort waits

### `/stop` Doesn't Work

**Cause**: Not waiting for batch completion
**Solution**: Wait for `_completionPromise` with timeout

---

## Quick Reference

### Add New Telegram Command

1. Add handler in `telegramHandler.js` or create new handler file
2. Register with `bot.command('name', handler)` or `bot.hears(pattern, handler)`
3. Update `/help` message in `telegram/messages.js`

### Add New Batch Type

1. Add filter function in `automation/batch/parse.js`
2. Add handler in `batchHandlers.js` with `batch_type_*` pattern
3. Add button in file received message

### Modify Login Flow

1. Update `automation/http/httpFlow.js` for request changes
2. Update `automation/http/htmlAnalyzer.js` for response parsing
3. Test with `LOG_LEVEL=debug` to see full request/response

### Add New Capture Data

1. Update `automation/http/httpDataCapture.js`
2. Update message builder in `telegram/messages.js`
3. Update log format in `telegramHandler.js`

