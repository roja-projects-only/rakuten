Default shell is PowerShell; keep commands compatible. Avoid generating docs unless asked. Favor small, composable functions.

The user's has an apostraphe and it should required to be closed in quote.

# Rakuten Telegram Credential Checker — AI Agent Playbook

## Architecture Overview
```
main.js                      # Bootstrap: env validation, Telegraf init, graceful shutdown
telegramHandler.js           # Command routing (.chk), input guards, response formatting
├── telegram/messages.js     # MarkdownV2 builders (escapeV2, codeV2, spoilerV2, boldV2)
├── telegram/batchHandlers.js # HOTMAIL file uploads + ULP URL batch processing
httpChecker.js               # HTTP-based credential checker (cres POW implemented)
```

### HTTP Flow
`httpChecker.js` → `httpFlow.js` → `htmlAnalyzer.js` → `httpDataCapture.js`

## cres Algorithm (Proof-of-Work)
The `cres` (challenge response) is computed from `/util/gc` mdata (`{mask, key, seed}`):
1. `stringToHash = key + random(16 - key.length)` 
2. `hash = MurmurHash3_x64_128(stringToHash, seed)`
3. Loop until `hash.startsWith(mask)`
4. Return `stringToHash` as cres

Implementation: `automation/http/fingerprinting/challengeGenerator.js`

## Environment Variables
| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `TELEGRAM_BOT_TOKEN` | ✓ | — | From @BotFather |
| `TARGET_LOGIN_URL` | ✓ | — | Full OAuth URL with `client_id`, `redirect_uri` |
| `TIMEOUT_MS` | | `60000` | HTTP timeout |
| `BATCH_CONCURRENCY` | | `1` | Parallel checks (1 = sequential) |
| `BATCH_MAX_RETRIES` | | `1` | Retry count for ERROR results |
| `BATCH_DELAY_MS` | | `500` | Delay between requests |
| `LOG_LEVEL` | | `info` | error\|warn\|info\|debug |
| `PROXY_SERVER` | | — | Proxy URL |

## Commands & Workflows
```powershell
npm install          # Install deps
npm start            # Run bot
$env:LOG_LEVEL="debug"; npm start  # Verbose logging
```

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
3. `filterAlreadyProcessed()` dedupes via `processedStore.js` (JSONL cache with TTL)
4. Worker pool processes with `BATCH_CONCURRENCY`; progress edits throttled to ~5s
5. Summary with valid creds in spoiler format

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
// Returns: { points, cash, rank }
```

## File Conventions
- `automation/http/` — HTTP flow, fingerprinting, data capture
- `automation/batch/` — `hotmail.js`, `ulp.js`, `processedStore.js` (dedup cache)
- `telegram/` — Message builders, batch UX handlers

## Batch Domain Filter
HOTMAIL mode only accepts: `live.jp`, `hotmail.co.jp`, `hotmail.jp`, `outlook.jp`, `outlook.co.jp`, `msn.co.jp`

## Key Constants
- Telegram file download limit: 20MB
- ULP stream limit: ~1.5GB
- Processed cache TTL: 7 days (env `PROCESSED_TTL_MS`)
- Progress edit throttle: 5 seconds
