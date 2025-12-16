# 🎌 Rakuten Credential Checker Bot

High-speed HTTP-based Telegram bot for validating Rakuten account credentials with automatic points/rank capture.

## ✨ Features

- ⚡ **Fast HTTP-based** - No browser overhead, 10-50x faster than Puppeteer
- 📊 **Auto-capture** - Points, Rakuten Cash, and membership rank
- 🔄 **Live updates** - Real-time progress with visual indicators
- 📦 **Batch processing** - Check hundreds of credentials from files
- 🔒 **Secure** - Credential masking and spoiler tags

## 🚀 Quick Start

```powershell
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your settings

# 3. Start the bot
npm start
```

## ⚙️ Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | - | Bot token from @BotFather |
| `TARGET_LOGIN_URL` | ✅ | - | Rakuten OAuth login URL |
| `TIMEOUT_MS` | ❌ | `60000` | Request timeout (ms) |
| `BATCH_CONCURRENCY` | ❌ | `30` | Parallel batch checks |
| `BATCH_MAX_RETRIES` | ❌ | `2` | Retry count for ERROR results |
| `PROXY_SERVER` | ❌ | - | Proxy URL (http://host:port) |
| `LOG_LEVEL` | ❌ | `info` | Logging: error\|warn\|info\|debug |

## 📖 Commands

### Single Check
```
.chk email:password
```
Checks one credential and auto-captures account data if valid.

### Batch Processing
1. Upload a `.txt` file with credentials (one per line: `email:password`)
2. Choose processing type:
   - **HOTMAIL** - Microsoft .jp domains only
   - **ULP** - Rakuten domains only

### URL Batch
```
.ulp https://example.com/credentials.txt
```
Process credentials from a remote URL.

## 📊 Status Codes

| Status | Emoji | Description |
|--------|-------|-------------|
| `VALID` | ✅ | Login successful, data captured |
| `INVALID` | ❌ | Wrong credentials |
| `BLOCKED` | 🔒 | Account locked/captcha |
| `ERROR` | ⚠️ | Technical failure |

## 🏗️ Architecture

```
main.js                     # Entry point, environment setup
httpChecker.js              # Core credential checker
telegramHandler.js          # Telegram bot commands
├── telegram/
│   ├── messages.js         # Message formatters (MarkdownV2)
│   └── batchHandlers.js    # File/URL batch processing
└── automation/
    ├── http/
    │   ├── httpFlow.js     # Login flow (navigate → email → password)
    │   ├── httpClient.js   # Axios client with cookie jar
    │   ├── sessionManager.js  # Session lifecycle
    │   ├── htmlAnalyzer.js # Response outcome detection
    │   ├── httpDataCapture.js # Points/Cash/Rank API capture
    │   └── fingerprinting/
    │       ├── challengeGenerator.js  # cres POW algorithm
    │       ├── ratGenerator.js        # RAT fingerprint data
    │       └── bioGenerator.js        # Behavioral biometrics
    └── batch/
        ├── hotmail.js      # HOTMAIL domain filter
        ├── ulp.js          # Rakuten domain filter
        └── processedStore.js # Dedup cache (7-day TTL)
```

## 🔐 cres Algorithm

The login uses a Proof-of-Work challenge. The `/util/gc` endpoint returns:

```json
{ "mask": "abcd", "key": "e2", "seed": 3973842396 }
```

The algorithm computes a 16-char string where `MurmurHash3_x64_128(string, seed)` starts with `mask`.

Implementation: `automation/http/fingerprinting/challengeGenerator.js`

## 📡 Data Capture API

After login, account data is fetched from:

```
POST https://ichiba-common-web-gateway.rakuten.co.jp/ichiba-common/headerinfo/get/v1
```

**Response fields:**
- `pointInfo.rank` - Membership (1=Regular, 2=Silver, 3=Gold, 4=Platinum, 5=Diamond)
- `pointInvestInfo.holdingPoint` - Total points
- `pointInfo.rcashPoint` - Rakuten Cash

## 🔧 Development

```powershell
# Run with debug logging
$env:LOG_LEVEL="debug"; npm start

# Run in production
npm start
```

## 📝 Batch Domain Filters

**HOTMAIL mode** accepts:
- `live.jp`, `hotmail.co.jp`, `hotmail.jp`
- `outlook.jp`, `outlook.co.jp`, `msn.co.jp`

**ULP mode** accepts:
- `rakuten.co.jp` domains

## 🛡️ Rate Limiting

- Processed credentials are cached for 7 days (configurable via `PROCESSED_TTL_MS`)
- Batch progress updates throttled to every 5 seconds
- Respect Rakuten's rate limits with appropriate delays

## 📄 License

MIT
