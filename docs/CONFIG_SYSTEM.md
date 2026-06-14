# Centralized Config Feature

## Overview

### Core Config System
1. **Schema** ([src/shared/config/configSchema.js](../src/shared/config/configSchema.js))
   - 15 hot-reloadable environment variables
   - Type validation (int, float, bool, enum, url, csv, string)
   - Range constraints and custom validators
   - Default values and precedence handling

2. **Service** ([src/shared/config/configService.js](../src/shared/config/configService.js))
   - Redis-backed storage with local caching
   - Pub/sub propagation to all instances
   - Get, set, reset, list operations
   - Subscription system for change notifications

3. **Telegram Handler** ([src/telegram/configHandler.js](../src/telegram/configHandler.js))
   - `/config` - List all settings
   - `/config get <KEY>` - Get details for a key
   - `/config set <KEY> <VALUE>` - Update a setting
   - `/config reset <KEY>` - Revert to env/default

### Integration Points
- [src/coordinator/index.js](../src/coordinator/index.js) - Coordinator initialization
- [src/worker/index.js](../src/worker/index.js) - Worker initialization  
- [src/telegram/telegramHandler.js](../src/telegram/telegramHandler.js) - Command registration
- [src/telegram/batch/batchExecutor.js](../src/telegram/batch/batchExecutor.js) - Uses `getBatchConfig()`
- [src/telegram/combineBatchRunner.js](../src/telegram/combineBatchRunner.js) - Uses `getBatchConfig()`
- [src/telegram/channelForwarder.js](../src/telegram/channelForwarder.js) - Uses `getChannelId()`
- [src/worker/WorkerNode.js](../src/worker/WorkerNode.js) - Uses `getWorkerConfig()`
- [src/coordinator/ProxyPoolManager.js](../src/coordinator/ProxyPoolManager.js) - Uses `getProxyConfig()`
- [src/coordinator/JobQueueManager.js](../src/coordinator/JobQueueManager.js) - Uses config getter

### Testing
- [scripts/tests/test-config-service.js](../scripts/tests/test-config-service.js) — Schema validation, Redis ops, pub/sub (48 tests)
- [scripts/tests/verify-config-deployment.js](../scripts/tests/verify-config-deployment.js) — Deployment smoke test
- [docs/TESTING.md](TESTING.md) — Testing guide (config system + local harness)

---

## Hot-Reloadable Variables

### Batch Processing
- `BATCH_CONCURRENCY` (1-50) - Parallel checks
- `BATCH_DELAY_MS` (0-5000) - Delay between chunks
- `BATCH_HUMAN_DELAY_MS` (0-1) - Human delay multiplier
- `BATCH_MAX_RETRIES` (0-10) - Max retries per credential
- `BATCH_TIMEOUT_MS` (30000-600000) - Task timeout
- `TIMEOUT_MS` (5000-120000) - HTTP request timeout

### Proxy
- `PROXY_SERVER` - Single proxy URL
- `PROXY_POOL` - Comma-separated proxy URLs
- `PROXY_HEALTH_CHECK_INTERVAL` (10000-300000) - Health check interval

### Forwarding
- `FORWARD_CHANNEL_ID` - Channel ID for VALID results
- `FORWARD_TTL_MS` (3600000-7776000000) - Message tracking TTL

### Cache
- `PROCESSED_TTL_MS` (3600000-7776000000) - Dedupe cache TTL

### Worker
- `WORKER_CONCURRENCY` (1-50) - Concurrent tasks per worker

### Logging
- `LOG_LEVEL` (error/warn/info/debug/trace) - Logging level
- `JSON_LOGGING` (true/false) - Structured JSON logging

---

## Usage

### Quick Start (After git pull)
```bash
# Update all services
npm run update

# Or specific service
npm run update:coordinator
npm run update:worker
npm run update:pow
```

### SSH into AWS Instance
```bash
ssh user@instance-ip
cd /app
git pull
./scripts/deploy/quick-update.sh
```

### Via Telegram
```
/config list
/config set BATCH_CONCURRENCY 10
/config get BATCH_CONCURRENCY
/config reset BATCH_CONCURRENCY
```

---

## Key Benefits

1. **No Downtime**: Change settings without restarting services
2. **Instant Propagation**: Updates reach all instances in <500ms
3. **Persistent**: Redis values survive restarts
4. **Validated**: Type checking prevents invalid values
5. **Controllable**: Manage from Telegram without SSH
6. **Safe**: Can reset to defaults anytime

---

## Troubleshooting

### Config service not initialized
- Check `REDIS_URL` is set
- Verify Redis connectivity: `redis-cli ping`
- Check logs for `"config service"`

### Changes not propagating
- Verify pub/sub subscription in logs
- Monitor Redis channel: `redis-cli SUBSCRIBE config_updates`
- Check worker logs for `"Config set:"` messages

### Values reverting after restart
- Expected behavior. Use `/config set` for persistent changes.
- Railway env vars reset on instance restart.
- Redis values persist across restarts.
