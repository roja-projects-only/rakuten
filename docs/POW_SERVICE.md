# POW Service Integration Guide

## Overview

The POW (Proof-of-Work) service provides HTTP-based POW computation with automatic fallback to local computation when the service is unavailable.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Credential Checker                        │
│                  (src/shared/http/flow.js)                   │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │  POW Service Client  │
              │ (powServiceClient.js)│
              │  - 25s timeout       │
              │  - Auto fallback     │
              │  - Local cache       │
              └──────────┬───────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
         ▼               ▼               ▼
    ┌────────┐      ┌────────┐      ┌────────┐
    │ POW    │      │ Local  │      │ Local  │
    │Service │      │Fallback│      │ Cache  │
    │(HTTP)  │      │(Sync)  │      │(Memory)│
    └────────┘      └────────┘      └────────┘
```

## Components

### 1. POW Service Client (`powServiceClient.js`)

HTTP client for communicating with the POW service.

**Features:**
- 25-second timeout for HTTP requests (`POW_CLIENT_TIMEOUT`, default 25000ms)
- Automatic fallback to local computation on timeout/error
- Local memory cache for fallback results (not Redis)
- Exponential backoff retry logic
- Statistics tracking

**Usage:**
```javascript
const powServiceClient = require('./src/shared/fingerprinting/powServiceClient');

// Compute cres with automatic fallback
const cres = await powServiceClient.computeCres({
  mask: '0000',
  key: 'abc123',
  seed: 12345
});

// Get client statistics
const stats = powServiceClient.getStats();
console.log('Success rate:', stats.requests.successRate);
console.log('Fallback rate:', stats.fallback.rate);
```

### 2. HTTP Flow (`src/shared/http/flow.js`)

The login flow uses the POW service client (via the `computeCresWithService()` helper) rather than calling local computation directly.

**Details:**
- `computeCresWithService()` wraps `powServiceClient.computeCres()` for consistent error handling
- POW service availability is checked on module load (skipped when `POW_SKIP_CONNECTION_TEST=1`)
- Logs a warning and uses local fallback when the service is unavailable
- The legacy `computeCresFromMdataAsync()` still exists in `challengeGenerator.js` and is used by the local fallback path

### 3. POW Service (`src/pow-service/index.js`)

Standalone HTTP service for POW computation.

**Endpoints:**
- `GET /` - Service banner and endpoint list
- `POST /compute` - Compute POW cres value. Request `{ mask, key, seed }` → `{ cres, cached, computeTimeMs }`. `mask`/`key` max length 32; `seed` must be a number. Errors: `400 INVALID_REQUEST`/`INVALID_TYPES`/`INVALID_LENGTH`, `408 POW_TIMEOUT`, `503 POW_OVERLOADED`, `422 POW_FAILED`, `500 COMPUTATION_ERROR`.
- `GET /health` - Health check: `{ status, timestamp, uptime, hashImplementation, redis, workerPool }` (cache statistics are exposed via `/metrics`, not here)
- `GET /metrics` - Prometheus metrics: `pow_requests_total{status}`, `pow_cache_hit_rate`, `pow_uptime_seconds`

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POW_SERVICE_URL` | No | `http://localhost:3001` | URL of the POW service |

### Example Configuration

**For AWS deployment:**
```bash
# .env
POW_SERVICE_URL=http://POW_PRIVATE_IP:8080
```

**For local development:**
```bash
# .env
POW_SERVICE_URL=http://localhost:3001
```

## Testing

### 1. Verify POW Service Integration

Quick verification script to test the integration:

```bash
npm run verify:pow-deployment
```

This will:
- Test POW service connection
- Verify computation works
- Check fallback behavior
- Display client statistics

### 2. Full Integration Tests

Comprehensive test suite:

```bash
npm run test:pow-integration
```

This runs:
- Service connection test
- Service vs local computation comparison
- Fallback behavior test
- Performance benchmarks
- Cache behavior test

### 3. Manual Testing

**Test with POW service running:**
```bash
# Terminal 1: Start POW service
npm run start:pow-service

# Terminal 2: Run verification
npm run verify:pow-deployment
```

**Test with POW service stopped:**
```bash
# Stop POW service (Ctrl+C)
# Run verification - should use fallback
npm run verify:pow-deployment
```

## Deployment

### AWS EC2 Deployment

The POW service runs as a Docker container on its own EC2 instance. See [AWS_SETUP.md](AWS_SETUP.md) for the full walkthrough. Summary:

1. **Build and run the container** (on the POW instance):
   ```bash
   ./scripts/deploy/quick-update.sh pow-service
   ```
   This publishes the service on host port `8080` (container `3001`).

2. **Point the coordinator and workers at it** via their `.env` files using the POW instance's **private** IP:
   ```bash
   POW_SERVICE_URL=http://POW_PRIVATE_IP:8080
   ```

3. **Verify the connection** in the coordinator/worker logs:
   ```
   ✅ "POW service connection verified"
   ⚠️  "POW service unavailable - will use local fallback"
   ```

### Monitoring

**Check POW service health** (from a host that can reach it, e.g. the POW instance itself):
```bash
curl http://localhost:8080/health
```

**Check metrics:**
```bash
curl http://localhost:8080/metrics
```

**Monitor cache hit rates:**
- Target: >60% cache hit rate
- Check logs every 100 requests for cache statistics

## Fallback Behavior

The system automatically falls back to local computation when:

1. **POW service is unavailable** (ECONNREFUSED, ENOTFOUND)
   - Logs: `POW service unavailable - using local fallback`
   
2. **POW service times out** (>`POW_CLIENT_TIMEOUT`, default 25 seconds)
   - Logs: `POW service timeout - using local fallback`
   
3. **POW service returns error** (5xx, invalid response)
   - Logs: `POW service error: {message} - using local fallback`

**Fallback characteristics:**
- Uses synchronous local POW computation
- Results cached in local memory (not Redis)
- 5-minute TTL for local cache entries
- LRU eviction when cache reaches 1000 entries

## Performance

### Expected Performance

| Scenario | Response Time | Notes |
|----------|---------------|-------|
| POW service (cache hit) | <50ms | Redis cache |
| POW service (cache miss) | 100-500ms | Worker thread computation |
| Local fallback | 200-800ms | Synchronous computation |
| POW service timeout | 25000ms + fallback time | Triggers fallback |

### Optimization Tips

1. **Ensure POW service is running** for best performance
2. **Monitor cache hit rates** - should be >60%
3. **Scale POW service** if response times exceed 500ms
4. **Check network latency** between services

## Troubleshooting

### Issue: POW service always unavailable

**Symptoms:**
- Logs show: `POW service unavailable - using local fallback`
- Fallback rate: 100%

**Solutions:**
1. Check `POW_SERVICE_URL` environment variable
2. Verify POW service is running: `curl $POW_SERVICE_URL/health`
3. Check network connectivity between services
4. Review POW service logs for errors

### Issue: High timeout rate

**Symptoms:**
- Logs show: `POW service timeout - using local fallback`
- Response times >25 seconds

**Solutions:**
1. Check POW service CPU usage
2. Scale POW service to more workers
3. Verify POW service worker pool is initialized
4. Check for network latency issues

### Issue: Low cache hit rate

**Symptoms:**
- Cache hit rate <60%
- Slow response times

**Solutions:**
1. Increase Redis cache TTL (currently 5 minutes)
2. Check if mask/key/seed combinations are highly variable
3. Monitor POW service cache statistics
4. Consider increasing cache size

## Migration Notes

### Breaking Changes

None - the integration is backward compatible.

### Rollback Procedure

If issues arise, the system automatically falls back to local computation. No manual rollback needed.

To completely revert to old behavior:
1. Remove `POW_SERVICE_URL` environment variable
2. System will use local computation exclusively

## Verification

```bash
# Check POW service health
curl http://localhost:3001/health

# Test POW computation
curl -X POST http://localhost:3001/compute \
  -H "Content-Type: application/json" \
  -d '{"mask":"0000","key":"abc123","seed":42}'

# Run deployment verification
npm run verify:pow-deployment
```