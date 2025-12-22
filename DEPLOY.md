# Quick Deployment Guide

## 🚀 Deploy Worker Timeout Fix

**Single command to fix all timeout issues:**

```bash
cd ~/rakuten
git pull
chmod +x scripts/deploy/deploy-worker-fix.sh
./scripts/deploy/deploy-worker-fix.sh
```

## What This Does

1. **Backs up** your current configuration
2. **Updates** timeout settings in `.env.worker`
3. **Tests** Redis connectivity
4. **Rebuilds** worker Docker image with fixes
5. **Restarts** worker container
6. **Verifies** deployment success
7. **Shows** logs and monitoring commands

## Expected Output

```
╔══════════════════════════════════════════════════════════════╗
║                 Rakuten Worker Deployment                   ║
║                Redis Timeout Fix - v2.0                     ║
╚══════════════════════════════════════════════════════════════╝

✅ Backed up .env.worker to .env.worker.backup.20241222_150000
✅ Updated REDIS_COMMAND_TIMEOUT=60000
✅ Updated WORKER_QUEUE_TIMEOUT=30000
✅ Redis connectivity test passed
✅ Worker container started successfully
✅ No timeout errors detected in logs

╔══════════════════════════════════════════════════════════════╗
║                    DEPLOYMENT SUCCESSFUL                    ║
╚══════════════════════════════════════════════════════════════╝
```

## Verification

After deployment, verify with:
```bash
./scripts/deploy/verify-deployment.sh
```

## Monitoring

```bash
# Watch logs
docker logs -f rakuten-worker

# Check status
docker ps | grep rakuten-worker

# Test Redis connectivity
docker exec rakuten-worker node scripts/deploy/test-redis-connectivity.js
```

## Rollback (if needed)

```bash
./scripts/deploy/rollback-worker.sh
```

## Files Changed

- `.env.worker` - Updated with timeout configurations
- Docker image - Rebuilt with latest timeout fixes
- Container - Restarted with new configuration

## Timeout Settings Applied

- `REDIS_COMMAND_TIMEOUT=60000` (60 seconds)
- `WORKER_QUEUE_TIMEOUT=30000` (30 seconds)  
- `WORKER_TASK_TIMEOUT=120000` (2 minutes)
- `WORKER_HEARTBEAT_INTERVAL=10000` (10 seconds)

## Success Indicators

- ✅ No "Command timed out" errors in logs
- ✅ Worker registration successful
- ✅ Heartbeat mechanism working
- ✅ Redis connectivity confirmed
- ✅ Container running and healthy

## Support

If deployment fails:
1. Check the error output
2. Run `./scripts/deploy/verify-deployment.sh`
3. Check Redis server status: `redis-cli ping`
4. Review logs: `docker logs rakuten-worker`
5. Rollback if needed: `./scripts/deploy/rollback-worker.sh`