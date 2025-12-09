# 🎯 Rakuten Telegram Credential Checker

Automated credential validation bot for Rakuten accounts with live status updates, screenshot evidence, and interactive buttons.

## ✨ Features

- 🔄 **Live Updates** - Message editing with real-time status
- 📸 **Screenshot Evidence** - Automatic capture on errors
- 🎭 **Random User Agents** - Avoid detection patterns
- 🔒 **Masked Credentials** - Privacy protection
- 🎮 **Interactive Buttons** - Quick actions for valid accounts
- ⚡ **Fast & Reliable** - Headless Chrome automation

## 🚀 Quick Start

**New here? Read [QUICKSTART.md](QUICKSTART.md) for setup instructions!**

```powershell
# 1. Install dependencies
npm install

# 2. Configure bot token
cp .env.example .env
# Edit .env with your TELEGRAM_BOT_TOKEN

# 3. Start the bot
npm start
```

## 📖 Usage

Send to your bot:
```
.chk username:password
```

Example:
```
.chk john@example.com:mypass123
```

## 📊 Status Indicators

| Emoji | Status | Description |
|-------|--------|-------------|
| ✅ | VALID | Credentials work perfectly |
| ❌ | INVALID | Wrong username or password |
| 🔒 | BLOCKED | Account locked or captcha required |
| ⚠️ | ERROR | Technical issue occurred |

## 🎯 Project Objective
- Receive Telegram command in format `.chk user:pass`
- Run secure headless Puppeteer automation
- Return categorized result with evidence
- Deploy on Windows VPS with PM2/NSSM

## Module boundaries
- **main.js / app.js** — bootstraps environment variables, starts the bot process, and wires dependencies.
- **telegramHandler.js** — listens for commands, parses `.chk user:pass`, guards inputs, and sends responses.
- **puppeteerChecker.js** — performs the credential verification via Puppeteer. The detailed plan below is the current deliverable.

## Detailed plan for `puppeteerChecker.js`
Goal: expose a single async function `checkCredentials({ username, password, options? })` that returns a structured result consumed by `telegramHandler`.

### Inputs / outputs
- **Inputs**: `username`, `password`, optional `options` (`timeoutMs`, `proxy`, `headless`, `userAgent`, `screenshotOn`, `targetUrl`).
- **Outputs**: `{ status, message, evidence? }` where `status` ∈ `["VALID", "INVALID", "BLOCKED", "ERROR"]`.
  - `VALID`: login succeeds or reaches the expected post-login marker.
  - `INVALID`: server returns “invalid credentials” style errors.
  - `BLOCKED`: captcha/challenge/lockout or rate-limit detected.
  - `ERROR`: navigation/timeouts/unhandled exceptions.

### Configuration defaults (Windows-friendly)
- Use `puppeteer.launch({ headless: "new", args: ["--no-sandbox"], timeout: timeoutMs ?? 60000 })`.
- Respect optional `proxy` via `args: ["--proxy-server=..."]` when provided.
- Set a desktop user agent if none is supplied.
- Configure navigation timeouts per-page (`page.setDefaultNavigationTimeout(timeoutMs)`).
- Ensure graceful cleanup with `try/finally` to close page & browser.

### Navigation & interaction flow
1. **Bootstrap**
   - Launch browser; create incognito context to avoid cookie bleed.
   - Open a new page; set user agent and viewport.
2. **Go to login page**
   - Navigate to `targetUrl` (env-driven, e.g. `process.env.TARGET_LOGIN_URL`) with `waitUntil: "networkidle2"`.
   - Wait for username/password selectors (`await page.waitForSelector(...)`).
3. **Fill credentials**
   - Type username/password with small delays to mimic human typing.
   - Optional: random short waits between fields to reduce bot-detection noise.
4. **Submit**
   - Click submit button and `Promise.all` on navigation/response (`waitUntil: "networkidle2"`).
5. **Outcome detection**
   - **Success markers**: presence of a dashboard element, redirect URL match, or HTTP 200 on a post-login resource.
   - **Invalid markers**: known error text near the form, toast/snackbar, or HTTP 401/403 on auth response.
   - **Blocked markers**: captcha widget presence, unexpected 429/503, or challenge/OTP screen.
6. **Evidence**
   - When `screenshotOn` is set (or on non-VALID states), take a screenshot and include its path/buffer for Telegram replies.
7. **Return**
   - Map detected marker to `{ status, message, evidence }`. Provide concise, user-safe message (do not echo password).

### Error handling & resilience
- Wrap the main flow in `try/catch` and classify errors:
  - Timeout/navigation errors → `status: "ERROR"`.
  - Captcha/challenge detection → `status: "BLOCKED"`.
  - Known invalid text → `status: "INVALID"`.
- Always `await browser.close()` in `finally`.
- Log minimal diagnostics (no secrets) for operator visibility.

### Pseudocode sketch
```js
async function checkCredentials({ username, password, options = {} }) {
  const browser = await puppeteer.launch(buildLaunchOptions(options));
  try {
    const page = await browser.newPage();
    await preparePage(page, options);
    await gotoLogin(page, options.targetUrl);
    await fillCredentials(page, { username, password });
    const outcome = await submitAndDetect(page);
    return outcome;
  } catch (err) {
    return { status: "ERROR", message: err.message };
  } finally {
    await browser.close().catch(() => {});
  }
}
```

This plan is ready for implementation and wiring into `telegramHandler.js` to deliver categorized Telegram replies.
