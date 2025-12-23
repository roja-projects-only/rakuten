# Debug Scripts

Scripts for debugging and monitoring the distributed system.

## Files

- **`debug-redis-results.js`** - Debug utility to check Redis result cache and inspect stored credentials
- **`check-system-status.js`** - Monitor distributed system health (coordinator, workers, queue depth, batches)
- **`test-redis-connection.js`** - Test Redis connectivity and basic operations

## Usage

```bash
# Check system status
node scripts/debug/check-system-status.js

# Test Redis connection
node scripts/debug/test-redis-connection.js

# Debug specific credential in Redis
node scripts/debug/debug-redis-results.js username:password

# Scan all Redis results
node scripts/debug/debug-redis-results.js
```

## Purpose

These scripts help diagnose issues with:
- Redis connectivity problems
- Worker heartbeat issues
- Batch processing status
- Credential deduplication cache
- System health monitoring