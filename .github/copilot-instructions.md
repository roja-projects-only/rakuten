- Default shell is PowerShell so use syntax compatible with it.
- Never create documentation unless instructed.
- Modolularize code into small functions.
- Always feature-proof this code for future integrations.

# Rakuten Telegram Credential Checker - AI Agent Instructions

## Architecture Overview

This is a **Telegram bot + Puppeteer automation** system with three core modules:

1. **main.js** - Bootstrap layer: validates env vars, wires dependencies, handles SIGINT/SIGTERM gracefully
2. **telegramHandler.js** - Command interface: listens for `.chk user:pass`, validates input (max 200 chars, requires `:` separator), formats responses with status emojis
3. **puppeteerChecker.js** - Automation engine: launches headless Chrome with incognito context, navigates to `TARGET_LOGIN_URL`, fills credentials with human-like delays (50ms typing, 300ms between fields), detects outcomes via HTML content matching

**Data flow**: Telegram message → parse/guard → `checkCredentials()` → Puppeteer automation → outcome detection → formatted response + optional screenshot

## Critical Patterns

### Status Classification System
The `detectOutcome()` function in puppeteerChecker.js uses **content-based detection**:
- `BLOCKED`: captcha/recaptcha/challenge indicators in HTML
- `INVALID`: "invalid"/"incorrect"/"wrong password" text in page content
- `VALID`: "dashboard"/"welcome" in content OR URL redirect away from login page
- `ERROR`: exceptions, timeouts, navigation failures

When adding new detection logic, always check **both** `page.url()` and `page.content()`.

### Windows-Specific Puppeteer Configuration
Always use these launch args (see `buildLaunchOptions()`):
```javascript
{ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] }
```
Use incognito context (`browser.createIncognitoBrowserContext()`) to prevent cookie bleed between checks.

### Screenshot Evidence Pattern
Screenshots save to `screenshots/` directory with naming: `{status}-{timestamp}.png`
- Taken automatically on non-VALID statuses
- Optional for all checks via `SCREENSHOT_ON=true`
- Files sent to Telegram as photo attachments with caption
- Directory created with `{ recursive: true }` to handle first-run

### Input Validation Guards
All credential inputs pass through `guardInput()` which enforces:
- Max 200 character length
- Presence of `:` separator
- Non-empty username and password after split
Validation errors return immediately with user-friendly messages - **never** echo passwords in error messages.

### Environment Variable Loading
`main.js` uses `dotenv.config()` at entry point. Required vars checked in `validateEnvironment()`:
- `TELEGRAM_BOT_TOKEN` (from BotFather)
- `TARGET_LOGIN_URL` (login page to automate)

Optional vars fallback to defaults in code (e.g., `TIMEOUT_MS || 60000`).

## Development Workflows

### Local Testing
```bash
npm install
cp .env.example .env
# Edit .env with your TELEGRAM_BOT_TOKEN and TARGET_LOGIN_URL
npm start
```

Bot runs with polling enabled - send `.chk test@example.com:password123` to test.

### Debugging Puppeteer Issues
1. Set `headless: false` in `buildLaunchOptions()` to see browser
2. Add `await page.screenshot()` calls before/after navigation steps
3. Check console logs - errors prefixed with `❌`, success with `✓`
4. Increase `timeoutMs` if navigation is slow (default 60s)

### Windows Service Deployment
This project targets Windows VPS deployment with NSSM or PM2 (see DEPLOYMENT.md). When modifying startup logic, ensure:
- Graceful shutdown handlers (`SIGINT`, `SIGTERM`) properly call `bot.stopPolling()`
- No interactive prompts (all config via environment variables)
- Logging goes to stdout (captured by service manager)

## Code Conventions

### Module Exports
Each module exports a **focused public API**:
- `puppeteerChecker.js`: only `checkCredentials()` function
- `telegramHandler.js`: `initializeTelegramHandler()` plus helper utilities for testing
- `main.js`: no exports (entry point only)

### Error Handling Strategy
Puppeteer operations use **try/finally with always-close**:
```javascript
try {
  // automation logic
} catch (err) {
  return { status: 'ERROR', message: err.message };
} finally {
  await browser.close().catch(() => {});  // silent cleanup
}
```

Never let browser instances leak - always close in finally block.

### Helper Function Pattern
Selector-finding helpers (`findInputField`, `findButton`) iterate through selector arrays and return **first match or null**. They handle both CSS selectors and text-based matching via `page.evaluate()` for flexibility across different login forms.

### Async Message Flow
Telegram handlers are async but don't await user responses - each `.chk` command is independent. The flow:
1. Parse immediately
2. Send "⏳ Checking..." status message (fire-and-forget)
3. Await `checkCredentials()`
4. Send result + screenshot (sequential to preserve message order)

## Integration Points

- **Telegram Bot API**: Uses `node-telegram-bot-api` with polling mode (not webhooks)
- **Puppeteer**: Full `puppeteer` package (bundled Chrome) - no `puppeteer-core` or custom `executablePath`
- **File System**: Screenshots written to `screenshots/` directory relative to `process.cwd()`

When adding new external dependencies, consider Windows compatibility and VPS deployment constraints.
