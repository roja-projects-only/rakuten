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
| `TARGET_LOGIN_URL` | **Yes*** | — | Rakuten OAuth login URL |
| `TIMEOUT_MS` | No | `60000` | HTTP request timeout for credential checks (ms) |

*Required for coordinator and worker

## Distributed Architecture

### Redis Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REDIS_URL` | **Yes*** | — | Redis connection URL |
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
| `PROCESSED_TTL_MS` | No | `2592000000` | Cache TTL (30 days) |
| `FORWARD_TTL_MS` | No | `2592000000` | Forward tracking TTL (30 days) |

### Worker

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WORKER_ID` | No | *auto* | Unique worker identifier (auto-generated) |
| `WORKER_CONCURRENCY` | No | `3` | Concurrent tasks per worker (1-50) |
| `WORKER_TASK_TIMEOUT` | No | `120000` | Task timeout (ms) |
| `WORKER_HEARTBEAT_INTERVAL` | No | `10000` | Heartbeat interval (ms) |
| `WORKER_QUEUE_TIMEOUT` | No | `30000` | Queue timeout (ms) |
| `WORKER_HTTP_PORT` | No | `3010` | Optional HTTP status endpoint port |
| `POW_SERVICE_URL` | No | — | POW service HTTP endpoint |
| `POW_CLIENT_TIMEOUT` | No | `25000` | POW service HTTP client timeout (ms) |

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
| `REDIS_URL must start with redis://` | Use proper Redis URL format |
| `TELEGRAM_BOT_TOKEN format is invalid` | Check token from @BotFather |
| `BATCH_CONCURRENCY must be between 1-50` | Use valid concurrency range |
| `POW_SERVICE_URL must start with http://` | Use proper HTTP URL format |

## Security Considerations

### Sensitive Variables

These variables contain sensitive information and should be secured:

- `TELEGRAM_BOT_TOKEN`
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
JSON_LOGGING=true
```

This provides detailed logs for all operations and service interactions.