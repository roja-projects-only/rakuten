# POW Service Integration Guide

## Overview

The POW (Proof-of-Work) service has been refactored to support a distributed architecture. The system now uses an HTTP-based POW service with automatic fallback to local computation when the service is unavailable.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Credential Checker                        │
│                      (httpFlow.js)                           │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │  POW Service Client  │
              │ (powServiceClient.js)│
              │  - 5s timeout        │
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
- 5-second timeout for HTTP requests (Requirement 3.1, 3.5)
- Automatic fallback to local computation on timeout/error (Requirement 3.6)
- Local memory cache for fallback results (not Redis) (Requirement 3.7)
- Exponential backoff retry logic
- Statistics tracking

**Usage:**
```javascript
const powServiceClient = require('./automation/http/fingerprinting/powServiceClient');

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

### 2. Updated HTTP Flow (`httpFlow.js`)

The HTTP flow has been updated to use the POW service client instead of direct local computation.

**Changes:**
- Replaced `computeCresFromMdataAsync()` with `powServiceClient.computeCres()`
- Added `computeCresWithService()` helper function for consistent error handling
- Added POW service availability check on module load
- Enhanced logging for service unavailability warnings

### 3. POW Service (`pow-service.js`)

Standalone HTTP service for POW computation (already implemented in task 2).

**Endpoints:**
- `POST /compute` - Compute POW cres value
- `GET /health` - Health check with cache statistics
- `GET /metrics` - Prometheus metrics

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POW_SERVICE_URL` | No | `http://localhost:3001` | URL of the POW service |

### Example Configuration

**For Railway deployment:**
```bash
# .env
POW_SERVICE_URL=http://pow-service.railway.app
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

### Railway Deployment

1. **Deploy POW Service** (if not already deployed):
   ```bash
   # Deploy POW service to Railway
   railway up -s pow-service
   ```

2. **Update Main Service Environment**:
   ```bash
   # Set POW_SERVICE_URL in Railway dashboard
   POW_SERVICE_URL=https://pow-service-production.up.railway.app
   ```

3. **Deploy Updated Code**:
   ```bash
   git add .
   git commit -m "feat: integrate POW service client with fallback"
   git push
   ```

4. **Verify Deployment**:
   ```bash
   # Check Railway logs for POW service connection
   railway logs
   
   # Look for:
   # ✅ "POW service connection verified"
   # ⚠️  "POW service unavailable - will use local fallback"
   ```

### Monitoring

**Check POW service health:**
```bash
curl https://pow-service-production.up.railway.app/health
```

**Check metrics:**
```bash
curl https://pow-service-production.up.railway.app/metrics
```

**Monitor cache hit rates:**
- Target: >60% cache hit rate (Requirement 3.8)
- Check logs every 100 requests for cache statistics

## Fallback Behavior

The system automatically falls back to local computation when:

1. **POW service is unavailable** (ECONNREFUSED, ENOTFOUND)
   - Logs: `POW service unavailable - using local fallback`
   
2. **POW service times out** (>5 seconds)
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
| POW service timeout | 5000ms + fallback time | Triggers fallback |

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
- Response times >5 seconds

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

## Requirements Satisfied

- ✅ **3.1**: Worker requests cres from POW service via HTTP with 5-second timeout
- ✅ **3.5**: Worker triggers local fallback on timeout
- ✅ **3.6**: Local fallback caches in local memory only (not Redis)
- ✅ **3.7**: System logs warning when POW service unavailable
- ✅ **3.8**: POW service logs cache statistics every 100 requests when hit rate >60%

## Next Steps

1. Deploy POW service to EC2 (Task 2.5)
2. Update Railway deployment with POW_SERVICE_URL
3. Monitor cache hit rates and response times
4. Implement worker nodes (Task 7)
5. Scale POW service based on load

## Support

For issues or questions:
1. Check Railway logs: `railway logs`
2. Run verification script: `npm run verify:pow-deployment`
3. Review POW service health: `curl $POW_SERVICE_URL/health`
4. Check client statistics in application logs