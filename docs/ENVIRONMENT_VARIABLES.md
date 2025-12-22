# Environment Variables Documentation

This document describes all environment variables supported by the Rakuten Credential Checker system, including both the original single-node deployment and the new distributed worker architecture.

## Deployment Modes

The system automatically detects the deployment mode based on environment variables:

- **Single-Node Mode**: When `REDIS_URL` is not set (original Railway deployment)
- **Coordinator Mode**: When `COORDINATOR_MODE=true` and `REDIS_URL` is set
- **Worker Mode**: When `REDIS_URL` is set but `COORDINATOR_MODE` is not true
- **POW Service Mode**: When `POW_SERVICE_MODE=true`

## Core Configuration

### Required for All Modes

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | No | `production` | Node.js environment (development, production, test) |
| `LOG_LEVEL` | No | `info` | Logging level (error, warn, info, debug, trace) |
| `JSON_LOGGING` | No | `false` | Enable structured JSON logging |

### Single-Node Mode (Original Deployment)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | **Yes** | — | Bot token from @BotFather |
| `TARGET_LOGIN_URL` | **Yes** | — | Full OAuth URL with client_id, redirect_uri |
| `TIMEOUT_MS` | No | `60000` | HTTP timeout for credential checks |
| `BATCH_CONCURRENCY` | No | `1` | Parallel checks (1 = sequential) |
| `BATCH_DELAY_MS` | No | `50` | Delay between request chunks (ms) |
| `BATCH_HUMAN_DELAY_MS` | No | `0` | Human delay multiplier (0=disabled, 0.1=10%) |
| `PROXY_SERVER` | No | — | Single proxy URL for all requests |
| `FORWARD_CHANNEL_ID` | No | — | Channel ID to forward VALID credentials |
| `ALLOWED_USER_IDS` | No | — | Comma-separated Telegram user IDs |
| `PROCESSED_TTL_MS` | No | `2592000000` | Cache TTL (30 days in ms) |
| `FORWARD_TTL_MS` | No | `2592000000` | Message tracking TTL (30 days in ms) |

## Distributed Architecture

### Redis Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REDIS_URL` | **Yes*** | — | Redis connection URL (enables distributed mode) |
| `REDIS_HOST` | No | `localhost` | Redis host (alternative to REDIS_URL) |
| `REDIS_PORT` | No | `6379` | Redis port (alternative to REDIS_URL) |
| `REDIS_PASSWORD` | No | — | Redis password (if required) |
| `REDIS_DB` | No | `0` | Redis database number (0-15) |

*Required for coordinator and worker modes

### Coordinator Mode

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `COORDINATOR_MODE` | **Yes** | `false` | Enable coordinator mode |
| `TELEGRAM_BOT_TOKEN` | **Yes** | — | Bot token from @BotFather |
| `TARGET_LOGIN_URL` | **Yes** | — | Target OAuth login URL |
| `BACKUP_COORDINATOR` | No | `false` | Enable backup coordinator (standby) |
| `FORWARD_CHANNEL_ID` | No | — | Channel ID for forwarding VALID credentials |
| `ALLOWED_USER_IDS` | No | — | Comma-separated allowed user IDs |
| `METRICS_PORT` | No | `9090` | Port for Prometheus metrics endpoint |
| `HEALTH_CHECK_PORT` | No | `8080` | Port for health check endpoint |

### Worker Mode

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WORKER_ID` | No | *auto* | Unique worker identifier (auto-generated) |
| `WORKER_CONCURRENCY` | No | `5` | Concurrent tasks per worker (1-50) |
| `POW_SERVICE_URL` | No | — | POW service HTTP endpoint |
| `POW_SERVICE_TIMEOUT` | No | `5000` | POW service timeout (1000-30000ms) |

### POW Service Mode

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POW_SERVICE_MODE` | **Yes** | `false` | Enable POW service mode |
| `PORT` | No | `3001` | HTTP server port |
| `REDIS_URL` | No | — | Redis for caching (optional) |

### Batch Processing

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BATCH_MAX_RETRIES` | No | `2` | Maximum retry attempts (0-10) |
| `BATCH_TIMEOUT_MS` | No | `120000` | Task timeout (30s-10min) |

### Proxy Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PROXY_POOL` | No | — | Comma-separated proxy URLs |
| `PROXY_HEALTH_CHECK_INTERVAL` | No | `30000` | Health check interval (10s-5min) |

### Monitoring

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `METRICS_PORT` | No | `9090` | Prometheus metrics port (1024-65535) |
| `HEALTH_CHECK_PORT` | No | `8080` | Health check port (1024-65535) |

## Migration Guide

### From Single-Node to Distributed

1. **Keep existing variables**: All current environment variables continue to work
2. **Add Redis**: Set `REDIS_URL` to enable distributed mode
3. **Choose mode**: Set `COORDINATOR_MODE=true` for the main instance
4. **Optional**: Add `POW_SERVICE_URL` for better performance

### Backward Compatibility

The system maintains full backward compatibility:

- **No Redis**: Automatically uses single-node mode with in-memory queue
- **Existing variables**: All original variables work unchanged
- **Graceful degradation**: Falls back to local computation if services unavailable

## Example Configurations

### Single-Node (Original)

```bash
# Required
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TARGET_LOGIN_URL="https://login.account.rakuten.com/sso/authorize?client_id=rakuten_ichiba_top_web&service_id=s245&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fwww.rakuten.co.jp%2F"

# Optional
BATCH_CONCURRENCY=5
PROXY_SERVER=http://proxy:8080
FORWARD_CHANNEL_ID=-1001234567890
LOG_LEVEL=info
```

### Distributed Coordinator

```bash
# Required
REDIS_URL=redis://localhost:6379
COORDINATOR_MODE=true
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TARGET_LOGIN_URL="https://login.account.rakuten.com/sso/authorize?client_id=rakuten_ichiba_top_web&service_id=s245&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fwww.rakuten.co.jp%2F"

# Optional
PROXY_POOL=http://proxy1:8080,http://proxy2:8080
POW_SERVICE_URL=http://pow-service:3001
FORWARD_CHANNEL_ID=-1001234567890
METRICS_PORT=9090
```

### Distributed Worker

```bash
# Required
REDIS_URL=redis://localhost:6379

# Optional
WORKER_CONCURRENCY=10
POW_SERVICE_URL=http://pow-service:3001
WORKER_ID=worker-01
```

### POW Service

```bash
# Required
POW_SERVICE_MODE=true

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