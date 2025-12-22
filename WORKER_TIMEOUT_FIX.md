# Worker Redis Timeout Fix Guide

## Problem
Workers experiencing "Command timed out" errors during:
- Task dequeuing (BLPOP operations)
- Heartbeat sending (SETEX/PUBLISH operations)
- Other Redis commands during batch processing

## Root Cause
1. Redis client `commandTimeout` (5s) was shorter than `WORKER_QUEUE_TIMEOUT` (30s)
2. Redis client options not properly merged when using `REDIS_URL`
3. Heartbeat operations timing out under load

## Solution Applied

### Code Changes
1. **Increased Redis command timeout**: 5s → 60s (configurable via `REDIS_COMMAND_TIMEOUT`)
2. **Fixed Redis client initialization**: Properly merge options when using `REDIS_URL`
3. **Enhanced heartbeat resilience**: Added timeout protection and better error handling
4. **Improved error classification**: Timeout errors no longer treated as fatal

### Configuration Changes
Added new environment variables in `.env.worker`:
```bash
REDIS_COMMAND_TIMEOUT=60000        # Must be > WORKER_QUEUE_TIMEOUT
WORKER_QUEUE_TIMEOUT=30000         # BLPOP timeout
WORKER_TASK_TIMEOUT=120000         # Max time per task
WORKER_HEARTBEAT_INTERVAL=10000    # Heartbeat frequency
```

## How to Apply the Fix

### On Your EC2 Instance

1. **Pull latest code** (if using git):
   ```bash
   cd ~/rakuten
   git pull
   ```

2. **Run the complete fix script**:
   ```bash
   chmod +x scripts/fix-worker-complete.sh
   ./scripts/fix-worker-complete.sh
   ```

   This script will:
   - Test Redis connectivity
   - Update `.env.worker` with timeout configurations
   - Rebuild the worker Docker image
   - Restart the worker container
   - Show logs to verify the fix

### Manual Steps (if script fails)

1. **Update `.env.worker`**:
   ```bash
   # Add these lines to .env.worker
   echo "" >> .env.worker
   echo "# Redis and Worker Timeout Configuration" >> .env.worker
   echo "REDIS_COMMAND_TIMEOUT=60000" >> .env.worker
   echo "WORKER_QUEUE_TIMEOUT=30000" >> .env.worker
   echo "WORKER_TASK_TIMEOUT=120000" >> .env.worker
   echo "WORKER_HEARTBEAT_INTERVAL=10000" >> .env.worker
   ```

2. **Rebuild worker**:
   ```bash
   docker stop rakuten-worker
   docker rm rakuten-worker
   docker rmi rakuten-worker
   docker build -f Dockerfile.worker -t rakuten-worker .
   ```

3. **Start worker**:
   ```bash
   docker run -d \
     --name rakuten-worker \
     --restart unless-stopped \
     --env-file .env.worker \
     rakuten-worker
   ```

4. **Verify**:
   ```bash
   docker logs -f rakuten-worker
   ```

## Verification

### Check for Success
Look for these in the logs:
```
✅ Redis connected successfully { ..., commandTimeout: 60000, connectTimeout: 10000 }
✅ Worker worker-X registered successfully
✅ Heartbeat sent (no timeout errors)
```

### Test Redis Connectivity
```bash
# Inside the container
docker exec rakuten-worker node scripts/test-redis-timeouts.js

# Or from host (if Node.js installed)
cd ~/rakuten
node scripts/test-redis-timeouts.js
```

### Monitor for Timeout Errors
```bash
# Watch for timeout errors
docker logs -f rakuten-worker | grep -i timeout

# Should see NO "Command timed out" errors
```

## Troubleshooting

### Still Seeing Timeout Errors?

1. **Check environment variables are loaded**:
   ```bash
   docker exec rakuten-worker env | grep -E "(REDIS_COMMAND_TIMEOUT|WORKER_QUEUE_TIMEOUT)"
   ```

2. **Verify Redis server performance**:
   ```bash
   # Check Redis latency
   redis-cli --latency
   
   # Check Redis info
   redis-cli info stats
   ```

3. **Check Redis server load**:
   ```bash
   # Monitor Redis commands
   redis-cli monitor
   
   # Check slow log
   redis-cli slowlog get 10
   ```

4. **Increase timeouts further** (if Redis is slow):
   ```bash
   # In .env.worker
   REDIS_COMMAND_TIMEOUT=120000  # 2 minutes
   WORKER_QUEUE_TIMEOUT=60000    # 1 minute
   ```

### Redis Connection Issues

If you see `ECONNREFUSED` or connection errors:
```bash
# Check Redis is running
sudo systemctl status redis

# Check Redis connectivity
redis-cli ping

# Check Redis URL
echo $REDIS_URL
```

### High Redis Latency

If Redis commands are slow:
```bash
# Check Redis memory usage
redis-cli info memory

# Check connected clients
redis-cli info clients

# Consider Redis optimization:
# - Increase Redis maxmemory
# - Enable Redis persistence optimization
# - Use Redis cluster for scaling
```

## Expected Behavior After Fix

- ✅ No "Command timed out" errors in logs
- ✅ Workers successfully dequeue and process tasks
- ✅ Heartbeats sent every 10 seconds without errors
- ✅ Batch processing completes successfully
- ✅ Workers remain stable during high load

## Performance Impact

- **Minimal**: Timeout increase doesn't affect normal operations
- **Improved resilience**: Workers handle Redis slowness better
- **Better error handling**: Timeout errors don't cause worker shutdown

## Rollback

If you need to rollback:
```bash
# Restore backup
cp .env.worker.backup.YYYYMMDD_HHMMSS .env.worker

# Rebuild with old code
git checkout <previous-commit>
./scripts/rebuild-worker.sh
```

## Additional Resources

- **Deployment docs**: `deployment/README.md` (updated with timeout configuration)
- **Redis client code**: `shared/redis/client.js`
- **Worker node code**: `shared/worker/WorkerNode.js`
- **Test script**: `scripts/test-redis-timeouts.js`

## Support

If issues persist after applying this fix:
1. Run the diagnostic script: `node scripts/test-redis-timeouts.js`
2. Check Redis server logs: `sudo journalctl -u redis -f`
3. Monitor worker logs: `docker logs -f rakuten-worker`
4. Check system resources: `htop`, `iostat`, `free -h`