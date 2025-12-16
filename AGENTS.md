Default shell is PowerShell; keep commands compatible. Avoid generating docs unless asked. Favor small, composable functions.

The user's has an apostraphe and it should required to be closed in quote.

# Rakuten Telegram Credential Checker — AI Agent Playbook

## Architecture Overview
```
main.js                      # Bootstrap: env validation, Telegraf init, graceful shutdown
telegramHandler.js           # Command routing (.chk), input guards, response formatting
├── telegram/messages.js     # MarkdownV2 builders (escapeV2, codeV2, spoilerV2, boldV2)
├── telegram/batchHandlers.js # HOTMAIL file uploads + ULP URL batch processing
puppeteerChecker.js          # Browser automation (DEFAULT, working)
httpChecker.js               # HTTP-only flow (cres POW implemented - needs testing)
```

### Checker Selection (`USE_HTTP_CHECKER` env)
- **Puppeteer (default)**: `browserManager.js` → `rakutenFlow.js` → `resultAnalyzer.js` → `dataCapture.js`
- **HTTP (experimental)**: `httpFlow.js` → `htmlAnalyzer.js` → `httpDataCapture.js` — cres POW implemented

## HTTP Checker: cres Algorithm Implemented
The `cres` (challenge response) is computed from `/util/gc` mdata (`{mask, key, seed}`) using a Proof-of-Work algorithm:
1. `stringToHash = key + random(16 - key.length)` 
2. `hash = MurmurHash3_x64_128(stringToHash, seed)`
3. Loop until `hash.startsWith(mask)`
4. Return `stringToHash` as cres

Implementation: `automation/http/fingerprinting/challengeGenerator.js` (reverse-engineered from `r10-challenger-0.2.1-a6173d7.js`)

## Environment Variables
| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `TELEGRAM_BOT_TOKEN` | ✓ | — | From @BotFather |
| `TARGET_LOGIN_URL` | ✓ | — | Full OAuth URL with `client_id`, `redirect_uri` |
| `USE_HTTP_CHECKER` | | `false` | `true` to use HTTP flow (cres POW implemented) |
| `TIMEOUT_MS` | | `60000` | Puppeteer/HTTP timeout |
| `BATCH_CONCURRENCY` | | `8` | Parallel checks in batch |
| `LOG_LEVEL` | | `info` | error\|warn\|info\|debug\|trace |
| `HEADLESS` | | `new` | `true`/`false`/`new` |
| `BROWSER_MAX_AGE_MS` | | `900000` | Recycle browser after 15min |
| `BROWSER_MAX_USES` | | `100` | Recycle after N sessions |

## Commands & Workflows
```powershell
npm install          # Install deps
npm start            # Run bot (no test suite)
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
`.chk email:password` → `guardInput()` validates format → `parseCredentials()` splits → `checkCredentials()` (Puppeteer) → outcome: VALID/INVALID/BLOCKED/ERROR → auto-capture on VALID → edit status message

### Batch Flow
1. User uploads file → `batch_type_hotmail_*` or `batch_type_ulp_*` callback
2. `prepareBatchFromFile()` or `prepareUlpBatch()` parses credentials
3. `filterAlreadyProcessed()` dedupes via `processedStore.js` (JSONL cache with TTL)
4. Worker pool processes with `BATCH_CONCURRENCY`; progress edits throttled to ~5s
5. Summary with valid creds in spoiler format

### Puppeteer Session Pattern
```javascript
// browserManager.js provides shared browser with auto-recycle
const session = await createBrowserSession({ proxy, headless });
// session = { browser, context, page, isShared: true }
// Always close context, not browser (shared instance)
await closeBrowserSession(session);
```

### Outcome Detection (`resultAnalyzer.js`)
- HTTP 200 + redirect to `rakuten.co.jp?code=` → VALID
- HTTP 401 / JSON errorCode → INVALID
- Captcha/challenge keywords in HTML → BLOCKED
- Fallback → ERROR

## File Conventions
- `automation/` — Puppeteer helpers, batch processing, HTTP flow
- `automation/batch/` — `hotmail.js` (Microsoft .jp domains), `ulp.js` (URL/file), `processedStore.js` (dedup cache)
- `telegram/` — Message builders, batch UX handlers
- `screenshots/` — Auto-created, screenshots deleted after Telegram send

## Batch Domain Filter
HOTMAIL mode only accepts: `live.jp`, `hotmail.co.jp`, `hotmail.jp`, `outlook.jp`, `outlook.co.jp`, `msn.co.jp`

## Key Constants
- Telegram file download limit: 20MB
- ULP stream limit: ~1.5GB
- Processed cache TTL: 7 days (env `PROCESSED_TTL_MS`)
- Progress edit throttle: 5 seconds

---
*Ask to expand: capture selectors, rakutenFlow step details, batch parsing edge cases, HTTP flow testing*
