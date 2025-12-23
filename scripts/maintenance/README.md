# Maintenance Scripts

Scripts for maintaining and cleaning up the distributed system.

## Files

- **`fix-redis-data.js`** - Clean up corrupted Redis keys and fix data type conflicts
- **`clear-redis-conflicts.js`** - Clear Redis data type conflicts (legacy)
- **`emergency-clear-redis.js`** - Emergency Redis cleanup script

## Usage

```bash
# Clean up problematic Redis data
node scripts/maintenance/fix-redis-data.js

# Emergency Redis cleanup (use with caution)
node scripts/maintenance/emergency-clear-redis.js
```

## Purpose

These scripts handle:
- WRONGTYPE Redis errors
- Corrupted progress tracking data
- Stale coordinator heartbeats
- Orphaned worker heartbeats
- Pending forward states
- Data type conflicts

## When to Use

- After system crashes
- When coordinator fails to start with WRONGTYPE errors
- Before major system updates
- When Redis data becomes inconsistent
- During troubleshooting distributed mode issues

## ⚠️ Warning

These scripts delete Redis data. Use with caution in production environments.