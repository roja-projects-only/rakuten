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

### Docker Compose (Recommended)
```powershell
# 1. Install dependencies
npm install

# 2. Configure environment
copy .env.example .env
# Edit .env with your TELEGRAM_BOT_TOKEN, TARGET_LOGIN_URL, REDIS_URL

# 3. Start all services
docker compose -f deployment/docker/docker-compose.yml up -d
```

### Local Development
```powershell
# 1. Install dependencies
npm install

# 2. Configure environment
copy .env.example .env
# Edit .env with your settings

# 3. Start coordinator (requires Redis)
npm run start:coordinator

# 4. Start worker (in separate terminal)
npm run start:worker

# 5. Start POW service (in separate terminal)
npm run start:pow-service
```

## 📁 Project Structure

```
src/
├── coordinator/          # Coordinator service (Telegram bot + job orchestration)
│   ├── index.js          # Entrypoint
│   ├── Coordinator.js    # Main orchestrator
│   ├── JobQueueManager.js # Redis-based task queue
│   ├── ProgressTracker.js # Batch progress tracking
│   ├── ProxyPoolManager.js # Proxy rotation
│   ├── ChannelForwarder.js # Channel forwarding
│   ├── MetricsManager.js # Prometheus metrics
│   └── MetricsServer.js  # Metrics HTTP endpoint
├── worker/               # Worker service (credential checking)
│   ├── index.js          # Entrypoint
│   └── WorkerNode.js     # Worker execution loop
├── pow-service/          # POW service (proof-of-work computation)
│   └── index.js          # Entrypoint with inline POWService
├── shared/               # Shared modules
│   ├── config/           # Environment validation and config service
│   ├── logger/           # Structured logging
│   ├── redis/            # Redis client and key schema
│   ├── http/             # HTTP client, flow, analyzer, checker
│   ├── batch/            # Batch processing, parsing, processed store
│   ├── fingerprinting/   # POW challenge, bio/rat generators
│   ├── capture/          # Account data capture
│   ├── payloads/         # Request payloads
│   ├── errors/           # Error handling
│   └── utils/            # Utility functions
└── telegram/             # Telegram bot handlers
    ├── telegramHandler.js # Bot setup and command registration
    ├── messages/          # Message formatting helpers
    ├── batch/             # Batch processing handlers
    ├── combineHandler.js  # /combine command
    ├── combineBatchRunner.js # Combine batch execution
    ├── channelForwarder.js # Channel forwarding
    ├── channelForwardStore.js # Forward dedup store
    ├── configHandler.js   # /config command
    ├── exportHandler.js   # Export VALID credentials
    ├── statusHandler.js   # /status command
    └── messageTracker.js  # Forwarded message updates

deployment/
├── docker/               # Docker configuration
│   ├── Dockerfile.coordinator
│   ├── Dockerfile.worker
│   ├── Dockerfile.pow-service
│   └── docker-compose.yml
├── railway/              # Railway configuration
│   └── railway.json
├── redis.conf            # Redis configuration
├── *.service             # Systemd service files
├── *.sh                  # User-data scripts
└── *.example             # Environment templates

scripts/
├── deploy/               # Deployment scripts
├── tests/                # Integration and unit tests
├── maintenance/          # Redis cleanup and maintenance
├── debug/                # Debug utilities
└── migration/            # Data migration scripts

docs/                     # Project documentation
```

## ⚙️ Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | - | Bot token from @BotFather |
| `TARGET_LOGIN_URL` | ✅ | - | Rakuten OAuth login URL |
| `REDIS_URL` | ✅ | - | Redis connection URL |
| `FORWARD_CHANNEL_ID` | ❌ | - | Channel ID to forward VALID credentials |
| `TIMEOUT_MS` | ❌ | `60000` | Request timeout (ms) |
| `BATCH_CONCURRENCY` | ❌ | `1` | Parallel batch checks (1 = sequential) |
| `BATCH_MAX_RETRIES` | ❌ | `1` | Retry count for ERROR results |
| `BATCH_DELAY_MS` | ❌ | `50` | Delay between request chunks (ms) |
| `BATCH_HUMAN_DELAY_MS` | ❌ | `0` | Human delay multiplier for batch (0=skip, 0.1=10%) |
| `PROXY_SERVER` | ❌ | - | Proxy URL (any format) |
| `LOG_LEVEL` | ❌ | `info` | Logging: error\|warn\|info\|debug |
| `WORKER_CONCURRENCY` | ❌ | `3` | Concurrent tasks per worker |
| `POW_SERVICE_URL` | ❌ | - | POW service endpoint |

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

### Combine
`/combine` → upload files → `/done` → choose type → confirm.

### Config & Status
- `/config` — view or set centralized config
- `/status` — system health and workers

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

Implementation: `src/shared/fingerprinting/challengeGenerator.js`

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
# Run coordinator with debug logging
$env:LOG_LEVEL="debug"; npm run start:coordinator

# Run worker
npm run start:worker

# Run POW service
npm run start:pow-service

# Run all tests
npm run test:integration
```

## 📝 Batch Domain Filters

**HOTMAIL mode** accepts:
- `live.jp`, `hotmail.co.jp`, `hotmail.jp`
- `outlook.jp`, `outlook.co.jp`, `msn.co.jp`

**ULP mode** accepts:
- `rakuten.co.jp` domains

## 🛡️ Rate Limiting

- Processed credentials are cached for 30 days (configurable via `PROCESSED_TTL_MS`)
- Batch progress updates throttled to every 5 seconds
- Respect Rakuten's rate limits with appropriate delays

## 🚀 Deployment

### Docker Compose
```powershell
# Build and start all services
docker compose -f deployment/docker/docker-compose.yml up -d

# View logs
docker compose -f deployment/docker/docker-compose.yml logs -f coordinator

# Stop all services
docker compose -f deployment/docker/docker-compose.yml down
```

### Railway
1. Push to GitHub
2. Connect repo to Railway
3. Add Redis service in Railway (click "New" → "Database" → "Redis")
4. Set environment variables in Railway dashboard
5. Deploy — Railway auto-detects Node.js and builds native dependencies

Config file: `deployment/railway/railway.json`

### AWS EC2
See `deployment/DEPLOYMENT.md` for detailed AWS setup instructions.

## 📚 Developer docs

- [AGENTS.md](AGENTS.md) — Agent playbook (quick start, entry points, patterns, commands)
- [AI_CONTEXT.md](AI_CONTEXT.md) — Architecture, data flows, storage, and how-tos
- [docs/](docs/) — Migration records and implementation documentation

## 📄 License

MIT
