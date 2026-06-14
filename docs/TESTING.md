# Testing the Centralized Config System

## Quick Tests (Local)

### 1. Schema Validation Test
```bash
node scripts/tests/test-config-service.js
```
**Expected**: All 48 tests pass (schema validation, Redis ops, pub/sub)

### 2. Deployment Verification
```bash
node scripts/tests/verify-config-deployment.js
```
**Expected**: Config service loads, reads values from env/defaults

---

## Testing on AWS/Railway Instances

### Option 1: Via Railway CLI

1. **Check coordinator status:**
```bash
railway run --service coordinator node scripts/tests/verify-config-deployment.js
```

2. **Check worker status:**
```bash
railway run --service worker node scripts/tests/verify-config-deployment.js
```

**Expected output:**
- ✅ Config modules loaded
- ✅ Config service initialized (if Redis connected)
- ✅ Config values readable with sources (redis/env/default)

### Option 2: Via SSH (AWS EC2)

1. **SSH into coordinator instance:**
```bash
ssh user@coordinator-ip
cd /app
node scripts/tests/verify-config-deployment.js
```

2. **SSH into worker instance:**
```bash
ssh user@worker-ip
cd /app
node scripts/tests/verify-config-deployment.js
```

---

## Testing Config Commands via Telegram

### 1. List all configs
Send to bot:
```
/config
```
or
```
/config list
```

**Expected**: Formatted list grouped by category (batch, proxy, forward, worker, logging) with sources (🔴Redis | 🟡Env | ⚪Default)

### 2. Get specific config
```
/config get BATCH_CONCURRENCY
```

**Expected**: 
```
⚙️ BATCH_CONCURRENCY

Value: `1`
Source: default
Type: int
Range: 1 - 50
Default: `1`

Parallel credential checks
```

### 3. Set a config value
```
/config set BATCH_CONCURRENCY 10
```

**Expected**:
```
✅ Config Updated

Key: `BATCH_CONCURRENCY`
Value: `10`

Change propagated to all instances.
```

### 4. Verify propagation (check on another instance)
In another terminal, check worker logs:
```bash
railway logs --service worker
```

**Expected log line**:
```
Config set: BATCH_CONCURRENCY = 10
```

### 5. Reset to default
```
/config reset BATCH_CONCURRENCY
```

**Expected**:
```
✅ Config Reset

Key: `BATCH_CONCURRENCY`
Value: `1`

Reverted to env/default value.
```

---

## End-to-End Test Scenario

### Test Hot-Reload Without Restart

1. **Check current concurrency:**
```
/config get BATCH_CONCURRENCY
```

2. **Start a batch check** (upload a file via Telegram)

3. **While batch is running, change concurrency:**
```
/config set BATCH_CONCURRENCY 5
```

4. **Next batch** should use new concurrency (check logs for "concurrency=5")

5. **Verify on all instances:**
```bash
# Coordinator
railway logs --service coordinator | grep "Config set"

# Worker
railway logs --service worker | grep "Config set"
```

**Expected**: Both see the config update without restart

---

## Testing Different Configurations

### Batch Processing
```
/config set BATCH_CONCURRENCY 5
/config set BATCH_DELAY_MS 100
/config set BATCH_MAX_RETRIES 3
```

### Proxy Configuration
```
/config set PROXY_POOL http://p1:8080,http://p2:8080,http://p3:8080
/config set PROXY_HEALTH_CHECK_INTERVAL 60000
```

### Forwarding
```
/config set FORWARD_CHANNEL_ID -1001234567890
/config set FORWARD_TTL_MS 7776000000
```

### Worker Tuning
```
/config set WORKER_CONCURRENCY 10
/config set BATCH_TIMEOUT_MS 180000
```

### Logging
```
/config set LOG_LEVEL debug
/config set JSON_LOGGING true
```

---

## Troubleshooting

### Config service not initialized
**Symptom**: `/config` command not available or shows "not initialized"

**Check**:
1. Redis connectivity: `railway run redis-cli ping`
2. Environment variable: `railway variables | grep REDIS_URL`
3. Logs: `railway logs | grep "config service"`

**Fix**: Ensure `REDIS_URL` is set in Railway shared variables

### Changes not propagating
**Symptom**: Set config on coordinator but worker doesn't see it

**Check**:
1. Pub/sub subscription: Look for "Subscribed to config updates" in logs
2. Redis pub/sub: `redis-cli PUBSUB CHANNELS` should show `config_updates`

**Debug**:
```bash
# Monitor pub/sub channel
redis-cli SUBSCRIBE config_updates

# In another terminal
/config set BATCH_CONCURRENCY 7
```

### Values reverting after restart
**Symptom**: Config changes lost after instance restart

**Expected behavior**: This is normal! Redis values persist, env values don't.
- Redis values: Persist across restarts ✅
- Env values: Reset to Railway variables ✅
- Use `/config set` for persistent changes

---

## Monitoring Config Usage

### Check what's in Redis
```bash
railway run redis-cli --scan --pattern "config:*"
```

### Get all config values from Redis
```bash
for key in $(railway run redis-cli --scan --pattern "config:*"); do
  echo "$key: $(railway run redis-cli GET $key)"
done
```

### Monitor config changes in real-time
```bash
# On coordinator
railway logs --service coordinator -f | grep "Config"

# On worker
railway logs --service worker -f | grep "Config"
```

---

## Performance Notes

- Config reads are **instant** (local cache)
- Config writes take ~100-500ms (Redis + pub/sub)
- Pub/sub propagation: typically < 500ms
- No performance impact on batch processing

---

## Rollback Procedure

If config changes cause issues:

1. **Quick reset single value:**
```
/config reset <KEY>
```

2. **Reset all to defaults:**
```bash
railway run redis-cli --scan --pattern "config:*" | xargs railway run redis-cli DEL
```

3. **Full rollback to previous commit:**
```bash
git revert HEAD
git push
railway up
```

---

## Next Steps After Testing

Once all tests pass:

1. **Merge to main:**
```bash
git checkout main
git merge feature/centralized-config
git push
```

2. **Deploy to Railway:**
```bash
railway up
```

3. **Monitor first deployment:**
```bash
railway logs -f
```

4. **Test /config command** in production Telegram bot

5. **Document** any Railway-specific config in project README
