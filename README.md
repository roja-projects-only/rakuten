# 🎌 Rakuten Credential Checker Bot

High-speed distributed Telegram bot for validating Rakuten account credentials with automatic points/rank capture and horizontal scaling.

## ✨ Features

- ⚡ **Fast HTTP-based** - No browser overhead, 10-50x faster than Puppeteer
- 🏗️ **Distributed Architecture** - Horizontal scaling with Redis coordination
- 📊 **Auto-capture** - Points, Rakuten Cash, and membership rank
- 📡 **Channel forwarding** - Auto-forward VALID credentials to a channel (once per credential)
- 🔄 **Live updates** - Real-time progress with visual indicators
- 📦 **Batch processing** - Check hundreds of credentials from files
- 🔒 **Secure** - Credential masking and spoiler tags
- 🚀 **High Availability** - Coordinator failover and crash recovery

## 🏗️ Architecture

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

## 🚀 Quick Start

### Option 1: AWS EC2 Deployment (Recommended)
```powershell
# 1. Install dependencies
npm install

# 2. Configure for AWS
copy config\.env.coordinator .env
# Edit .env with your settings

# 3. Start coordinator
.\scripts\setup\fix-coordinator.bat
```

### Option 2: Local Development
```powershell
# 1. Install dependencies
npm install

# 2. Configure for local development
copy config\.env.local .env
# Edit .env with your settings

# 3. Start with Docker Compose
docker-compose up -d redis
.\scripts\setup\fix-coordinator-issue.ps1
```

## 📁 Project Structure

```
├── config/                 # Environment configurations
├── scripts/
│   ├── debug/             # System monitoring and debugging
│   ├── setup/             # Installation and configuration
│   ├── maintenance/       # Redis cleanup and maintenance
│   ├── tests/             # Integration and performance tests
│   ├── deploy/            # Deployment scripts
│   └── migration/         # Data migration utilities
├── shared/                # Distributed system components
│   ├── coordinator/       # Job orchestration and HA
│   ├── worker/           # Task processing
│   ├── redis/            # Redis client and schemas
│   └── config/           # Environment validation
├── telegram/             # Telegram bot handlers
├── automation/           # HTTP checking and batch processing
└── deployment/           # Docker and systemd configurations
```

## ⚙️ Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | - | Bot token from @BotFather |
| `TARGET_LOGIN_URL` | ✅ | - | Rakuten OAuth login URL |
| `FORWARD_CHANNEL_ID` | ❌ | - | Channel ID to forward VALID credentials |
| `TIMEOUT_MS` | ❌ | `60000` | Request timeout (ms) |
| `BATCH_CONCURRENCY` | ❌ | `1` | Parallel batch checks (1 = sequential) |
| `BATCH_MAX_RETRIES` | ❌ | `1` | Retry count for ERROR results |
| `BATCH_DELAY_MS` | ❌ | `50` | Delay between request chunks (ms) |
| `BATCH_HUMAN_DELAY_MS` | ❌ | `0` | Human delay multiplier for batch (0=skip, 0.1=10%) |
| `PROXY_SERVER` | ❌ | - | Proxy URL (any format) |
| `LOG_LEVEL` | ❌ | `info` | Logging: error\|warn\|info\|debug |
| `REDIS_URL` | ❌ | - | Redis URL for cloud (JSONL locally) |

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
   - **JP** - Any .jp domain
   - **ALL** - No domain filter

### Abort Batch
```
/stop
```
Aborts the currently running batch process.

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
│   ├── batchHandlers.js    # File/URL batch processing
│   ├── channelForwarder.js # Forward VALID creds to channel
│   └── channelForwardStore.js # Dedupe store for forwarding
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

**Optimizations:**
- Uses `murmurhash-native` (C++ bindings) on Linux/Railway for ~10x speedup
- Falls back to `murmurhash3js-revisited` (pure JS) on Windows/local dev
- Worker thread pool for non-blocking batch processing
- 5-minute cache for repeated mask+key+seed combinations

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

## 🚀 Deployment (Railway)

1. Push to GitHub
2. Connect repo to Railway
3. Add Redis service in Railway (click "New" → "Database" → "Redis")
4. Set environment variables in Railway dashboard:
   - `TELEGRAM_BOT_TOKEN`
   - `TARGET_LOGIN_URL`
   - `REDIS_URL` (auto-set if you link the Redis service)
5. Deploy — Railway auto-detects Node.js and builds native dependencies

Config file: `railway.json`

## 📄 License

MIT
