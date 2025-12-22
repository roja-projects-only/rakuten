# Residential Proxy Configuration Guide

## Environment Variables for Slow Residential Proxies

```bash
# Increase timeouts for slow residential connections
TIMEOUT_MS=180000                    # 3 minutes (vs 60s default)
POW_SERVICE_TIMEOUT=60000           # 1 minute for POW computation

# Retry configuration (already optimized)
BATCH_MAX_RETRIES=3                 # More retries for unstable connections
BATCH_DELAY_MS=100                  # Slight delay between requests

# Worker configuration (distributed mode)
WORKER_CONCURRENCY=2                # Lower concurrency for residential proxies
BATCH_TIMEOUT_MS=300000             # 5 minutes per task

# Proxy pool (multiple residential endpoints)
PROXY_POOL=user1:pass1@resi1.com:8080,user2:pass2@resi2.com:8080,user3:pass3@resi3.com:8080
```

## Proxy Format Examples

```bash
# BrightData format
PROXY_SERVER=brd-customer-hl_12345678-zone-residential:password@brd.superproxy.io:22225

# Smartproxy format  
PROXY_SERVER=user-session-12345:password@gate.smartproxy.com:10000

# Oxylabs format
PROXY_SERVER=customer-username-cc-US:password@pr.oxylabs.io:7777

# Generic residential
PROXY_SERVER=username:password@residential-proxy.com:8080
```

## Health Monitoring

The system automatically:
- Tracks proxy success/failure rates
- Removes proxies after 3 consecutive failures
- Restores proxies after successful requests
- Rotates through healthy proxies only

## Performance Tips

1. **Use sticky sessions** when possible (same proxy per credential)
2. **Lower concurrency** for residential proxies (2-3 vs 5-10)
3. **Increase timeouts** to handle slow connections
4. **Monitor proxy health** via metrics endpoint