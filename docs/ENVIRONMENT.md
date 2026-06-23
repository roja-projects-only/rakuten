# Environment Variables Documentation

This document describes all environment variables supported by the Rakuten Credential Checker distributed architecture.

## Deployment Modes

The system supports three services, each with its own entrypoint under `src/`:

- **Coordinator** (`node src/coordinator/index.js`): Telegram bot and job orchestration
- **Worker** (`node src/worker/index.js`): Credential checking workers
- **POW Service** (`node src/pow-service/index.js`): Proof-of-work computation service

## Core Configuration

### Common Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | No | `production` | Node.js environment (development, production, test) |
| `LOG_LEVEL` | No | `info` | Logging level (error, warn, info, debug, trace) |
| `LOG_FORMAT` | No | `human` | Log output format: `human` (ANSI colored, single-line) or `json` (single-line JSON to stdout). `JSON_LOGGING=true` is a legacy alias for `LOG_FORMAT=json` but `LOG_FORMAT` takes precedence if both are set. |
| `TARGET_LOGIN_URL` | **Yes*** | — | Rakuten OAuth login URL |
| `TIMEOUT_MS` | No | `60000` | HTTP request timeout for credential checks (ms) |

*Required for **coordinator only**. The worker reads `TARGET_LOGIN_URL` but does not hard-require it at startup (it is supplied per-task by the coordinator).

## Distributed Architecture

### Redis Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REDIS_URL` | **Yes*** | — | Redis connection URL (takes precedence over the discrete `REDIS_*` vars below) |
| `REDIS_HOST` | No | `localhost` | Redis host (used only when `REDIS_URL` is unset) |
| `REDIS_PORT` | No | `6379` | Redis port (used only when `REDIS_URL` is unset) |
| `REDIS_DB` | No | `0` | Redis database index (used only when `REDIS_URL` is unset) |
| `REDIS_PASSWORD` | No | — | Redis password (used only when `REDIS_URL` is unset; prefer embedding in `REDIS_URL`) |
| `REDIS_COMMAND_TIMEOUT` | No | `60000` | Redis command timeout (ms) |

*Required for coordinator and worker; optional for pow-service (caching)

### Coordinator

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | **Yes** | — | Bot token from @BotFather |
| `FORWARD_CHANNEL_ID` | No | — | Channel ID for forwarding VALID credentials |
| `ALLOWED_USER_IDS` | No | — | Comma-separated allowed user IDs |
| `METRICS_PORT` | No | `9090` | Port for Prometheus metrics endpoint |
| `METRICS_HOST` | No | `0.0.0.0` | Host to bind the metrics HTTP server |
| `BATCH_CONCURRENCY` | No | `1` | Parallel checks (1 = sequential) |
| `BATCH_MAX_RETRIES` | No | `2` | Max retry attempts per credential |
| `BATCH_DELAY_MS` | No | `50` | Delay between request chunks (ms) |
| `BATCH_HUMAN_DELAY_MS` | No | `0` | Human delay multiplier |
| `PROXY_SERVER` | No | — | Single proxy URL |
| `PROXY_POOL` | No | — | Comma-separated proxy URLs |
| `PROXY_HEALTH_CHECK_INTERVAL` | No | `30000` | Proxy health-check interval (ms) |
| `PROCESSED_TTL_MS` | No | `2592000000` | Cache TTL (30 days) |
| `FORWARD_TTL_MS` | No | `2592000000` | Forward tracking TTL (30 days) |
| `TELEGRAM_API_ROOT` | No | — | Local Bot API server URL (e.g., `http://localhost:8081`). When set, enables file downloads up to 2000MB instead of the 20MB cloud API limit |
| `TELEGRAM_API_ID` | No | — | Telegram API ID from my.telegram.org (for local Bot API server) |
| `TELEGRAM_API_HASH` | No | — | Telegram API hash from my.telegram.org (for local Bot API server) |

### Worker

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WORKER_ID` | No | *auto* | Unique worker identifier (auto-generated) |
| `WORKER_CONCURRENCY` | No | `3` | Concurrent tasks per worker (1-50) |
| `WORKER_TASK_TIMEOUT` | No | `120000` | Task timeout (ms) |
| `WORKER_HEARTBEAT_INTERVAL` | No | `10000` | Heartbeat interval (ms) |
| `WORKER_QUEUE_TIMEOUT` | No | `30000` | Queue timeout (ms) |
| `WORKER_HTTP_PORT` | No | `3010` | Optional HTTP status endpoint port |
| `POW_SERVICE_URL` | No | `http://localhost:3001`† | POW service HTTP endpoint |
| `POW_CLIENT_TIMEOUT` | No | `25000` | POW service HTTP client timeout (ms) |
| `POW_SKIP_CONNECTION_TEST` | No | — | Set to `1` to skip the POW service reachability check and use local computation directly (used by the test harness) |

†The POW client falls back to `http://localhost:3001` when `POW_SERVICE_URL` is unset. Production deployments must set it explicitly (e.g. the POW instance's private IP on port 8080).

### POW Service

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3001` | HTTP server port |
| `REDIS_URL` | No | — | Redis URL (optional, for result caching) |
| `POW_NUM_WORKERS` | No | *CPU-1* | Worker thread count |
| `POW_TASK_TIMEOUT` | No | `30000` | Task timeout (ms) |

## Example Configurations

### Coordinator

```bash
# Required
REDIS_URL=redis://localhost:6379
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TARGET_LOGIN_URL=https://login.account.rakuten.com/sso/authorize?client_id=rakuten_ichiba_top_web&service_id=s245&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fwww.rakuten.co.jp%2F

# Optional
PROXY_POOL=http://proxy1:8080,http://proxy2:8080
POW_SERVICE_URL=http://pow-service:3001
FORWARD_CHANNEL_ID=-1001234567890
METRICS_PORT=9090
```

### Local Bot API Server (Optional)

To increase the file download limit from 20MB to 2000MB, run a local [Telegram Bot API server](https://github.com/tdlib/telegram-bot-api) with `--local` mode:

1. Obtain `api_id` and `api_hash` from https://my.telegram.org
2. Add `TELEGRAM_API_ROOT`, `TELEGRAM_API_ID`, and `TELEGRAM_API_HASH` to `.env.coordinator` (all three go in the coordinator env file — the Bot API server container shares it)
3. Mount the Bot API server's data directory (`/var/lib/telegram-bot-api`) into the coordinator container (handled automatically by docker-compose and quick-update.sh)

When `TELEGRAM_API_ROOT` is set, the bot uses the local server for all Telegram API calls, and the file size limit is automatically raised from 20MB to 2000MB. Downloaded files are automatically deleted from the Bot API server's filesystem after each batch completes.

### Worker

```bash
# Required
REDIS_URL=redis://localhost:6379

# Optional
WORKER_CONCURRENCY=3
POW_SERVICE_URL=http://pow-service:3001
WORKER_ID=worker-01
```

### POW Service

```bash
# Optional
PORT=3001
REDIS_URL=redis://localhost:6379
```

## Validation Rules

The system validates all environment variables on startup:

- **Format validation**: URLs, ports, numeric ranges
- **Mode-specific requirements**: Different variables required per mode
- **Dependency checking**: Related variables validated together
- **Graceful fallbacks**: Invalid optional variables use defaults

## Error Messages

Common validation errors and solutions:

| Error | Solution |
|-------|----------|
| `REDIS_URL must start with redis:// or rediss://` | Use proper Redis URL format |
| `TELEGRAM_BOT_TOKEN format is invalid` | Check token from @BotFather |
| `BATCH_CONCURRENCY must be between 1-20` | Startup validator caps `BATCH_CONCURRENCY` at 20 (the `/config set` path allows up to 50) |
| `POW_SERVICE_URL must start with http:// or https://` | Use proper HTTP URL format |

> Startup validation (`environment.js`) and the `/config` validator (`configSchema.js`) use different
> ranges for some variables — see [CONFIG_SYSTEM.md](CONFIG_SYSTEM.md). A value accepted at startup may be
> rejected by `/config set`.

## Security Considerations

### Sensitive Variables

These variables contain sensitive information and should be secured:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `REDIS_PASSWORD`
- `REDIS_URL` (if contains password)

### Best Practices

1. **Use environment files**: Store in `.env` files (not committed to git)
2. **Rotate tokens**: Regularly rotate bot tokens and Redis passwords
3. **Limit access**: Use `ALLOWED_USER_IDS` to restrict bot access
4. **Monitor logs**: Watch for authentication failures

## Troubleshooting

### Common Issues

1. **Bot not responding**: Check `TELEGRAM_BOT_TOKEN` and network connectivity
2. **Redis connection failed**: Verify `REDIS_URL` and Redis server status
3. **Workers not processing**: Check Redis connectivity and queue status
4. **POW service timeout**: Verify `POW_SERVICE_URL` and service health

### Debug Mode

Enable debug logging for troubleshooting:

```bash
LOG_LEVEL=debug
LOG_FORMAT=json        # JSON output for structured log processing
```

Or use the legacy alias:
```bash
JSON_LOGGING=true      # Legacy alias for LOG_FORMAT=json (LOG_FORMAT takes precedence)
```

This provides detailed logs for all operations and service interactions.