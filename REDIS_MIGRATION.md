# Redis Migration Guide

## 🔄 Migrating from Old Railway Redis to New Railway Redis

This guide helps you migrate all data from your old single-node Railway Redis to your new Railway Redis instance.

## Prerequisites

- ✅ Both Redis URLs from Railway dashboard
- ✅ SSH access to your EC2 instance
- ✅ Node.js installed on EC2 instance
- ✅ Both Redis instances accessible

## Quick Migration

### Step 1: Run Migration Script

```bash
cd ~/rakuten
git pull
chmod +x scripts/deploy/migrate-redis.sh
./scripts/deploy/migrate-redis.sh
```

The script will:
1. Ask for your old and new Redis URLs
2. Test connections to both Redis instances
3. Show current key counts
4. Migrate all data preserving TTLs
5. Verify the migration

### Step 2: Update Configuration

After successful migration, update your worker configuration:

```bash
# Edit .env.worker to use new Redis URL
nano .env.worker

# Update REDIS_URL to your new Railway Redis URL
REDIS_URL=redis://default:password@new-redis-host:port

# Deploy with new configuration
./scripts/deploy/deploy-worker-fix.sh
```

### Step 3: Verify Migration

```bash
# Verify migration was successful
OLD_REDIS_URL="redis://old-url" NEW_REDIS_URL="redis://new-url" node scripts/deploy/verify-redis-migration.js
```

## What Gets Migrated

### ✅ All Key Types Supported
- **Strings**: Simple key-value pairs
- **Hashes**: Field-value maps
- **Lists**: Ordered collections
- **Sets**: Unique value collections  
- **Sorted Sets**: Scored collections
- **TTL Values**: Expiration times preserved

### ✅ Application Data
- `processed:*` - Processed credential cache
- `forward:*` - Forward tracking data
- `worker:*` - Worker registration data
- `batch:*` - Batch processing data
- `msg:*` - Message tracking data
- All other application keys

### ✅ Safety Features
- **Non-destructive**: Existing keys in new Redis are preserved
- **Verification**: Sample keys verified after migration
- **Progress tracking**: Real-time migration progress
- **Error handling**: Failed keys logged, migration continues

## Migration Process Details

### Phase 1: Connection & Discovery
```
🔍 Scanning all keys in old Redis...
Found 1,247 keys to migrate
```

### Phase 2: Batch Migration
```
Migrating batch 1/13 (100 keys)
Progress: 15.2% (189 migrated, 0 skipped, 0 errors)
```

### Phase 3: Verification
```
✅ Sample key verification passed
📊 Migration completed: 1,247 keys in 45 seconds
```

## Expected Output

```
╔══════════════════════════════════════════════════════════════╗
║                    Redis Data Migration                     ║
║              From Old Railway to New Railway                ║
╚══════════════════════════════════════════════════════════════╝

✅ Old Redis connection successful
✅ New Redis connection successful

Current key counts:
   Old Redis: 1247 keys
   New Redis: 0 keys

🎉 MIGRATION COMPLETED
============================================================
📊 Total Keys Found: 1247
✅ Successfully Migrated: 1247
⏭️  Skipped (already exist): 0
❌ Errors: 0
⏱️  Duration: 45 seconds
🚀 Rate: 28 keys/sec

📈 Key Types Migrated:
   string: 892
   hash: 234
   set: 89
   zset: 32
============================================================
```

## Troubleshooting

### Connection Issues

**Error**: `Cannot connect to Redis`
```bash
# Test Redis URLs manually
redis-cli -u "redis://your-old-url" ping
redis-cli -u "redis://your-new-url" ping

# Check Railway dashboard for correct URLs
# Ensure Redis instances are running
```

### Migration Errors

**Error**: `Migration failed for some keys`
```bash
# Check the error details in output
# Re-run migration (it will skip already migrated keys)
./scripts/deploy/migrate-redis.sh

# Verify specific keys manually
redis-cli -u "redis://old-url" get "problem-key"
redis-cli -u "redis://new-url" get "problem-key"
```

### Verification Issues

**Error**: `Key mismatches detected`
```bash
# Run detailed verification
OLD_REDIS_URL="redis://old" NEW_REDIS_URL="redis://new" node scripts/deploy/verify-redis-migration.js

# Check specific application keys
redis-cli -u "redis://new-url" keys "processed:*"
redis-cli -u "redis://new-url" keys "worker:*"
```

## Manual Migration (Alternative)

If the automated script fails, you can migrate specific key patterns:

```bash
# Export from old Redis
redis-cli -u "redis://old-url" --scan --pattern "processed:*" | xargs redis-cli -u "redis://old-url" dump > processed_keys.rdb

# Import to new Redis (requires redis-cli with --pipe)
# This is more complex - use the automated script instead
```

## Post-Migration Steps

### 1. Update All Configurations

Update Redis URLs in all configuration files:
- `.env.worker` (worker configuration)
- `.env.coordinator` (if using coordinator)
- Any other services using Redis

### 2. Deploy Updated Configuration

```bash
# Deploy worker with new Redis URL
./scripts/deploy/deploy-worker-fix.sh

# Restart any other services
docker restart rakuten-coordinator  # if applicable
```

### 3. Monitor Application

```bash
# Check worker logs
docker logs -f rakuten-worker

# Verify Redis connectivity
docker exec rakuten-worker node scripts/deploy/test-redis-connectivity.js

# Monitor key counts
redis-cli -u "redis://new-url" dbsize
```

### 4. Clean Up Old Redis

**⚠️ Only after verifying everything works:**

1. **Wait 24-48 hours** to ensure stability
2. **Backup old Redis** (if needed): `redis-cli -u "redis://old-url" --rdb backup.rdb`
3. **Delete old Railway Redis** from Railway dashboard
4. **Remove old Redis URL** from environment variables

## Rollback Plan

If issues occur after migration:

### Quick Rollback
```bash
# Update .env.worker back to old Redis URL
REDIS_URL=redis://old-railway-url

# Redeploy worker
./scripts/deploy/deploy-worker-fix.sh
```

### Data Rollback
If new Redis has issues, you can:
1. Keep old Redis running during transition period
2. Switch back to old Redis URL in configuration
3. Re-run migration later after fixing issues

## Performance Considerations

### Large Datasets
- Migration rate: ~20-50 keys/second
- 10,000 keys ≈ 5-8 minutes
- 100,000 keys ≈ 30-60 minutes

### During Migration
- Old Redis remains fully functional
- New Redis receives migrated data
- No downtime for your application

### Memory Usage
- Migration uses minimal memory
- Processes keys in batches of 100
- Safe for large datasets

## Security Notes

- ✅ Redis URLs are masked in logs
- ✅ No credentials stored in files
- ✅ Connections use SSL (if configured in Railway)
- ✅ Migration preserves all security settings

## Support

If migration fails or you need help:

1. **Check logs**: Migration script provides detailed error messages
2. **Verify URLs**: Ensure both Redis URLs are correct and accessible
3. **Test manually**: Use `redis-cli` to test connections
4. **Run verification**: Use the verification script to check data integrity
5. **Rollback if needed**: Switch back to old Redis URL temporarily

The migration is designed to be safe and non-destructive. Your old Redis data remains untouched during the process.