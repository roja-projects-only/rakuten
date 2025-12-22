#!/usr/bin/env node

/**
 * Redis Data Migration Script
 * 
 * Migrates data from old Railway Redis to new Railway Redis
 * Handles all key types: strings, hashes, lists, sets, sorted sets
 * Preserves TTL values where possible
 */

const Redis = require('ioredis');
const { createLogger } = require('../logger');

const log = createLogger('redis-migration');

// Configuration
const OLD_REDIS_URL = process.env.OLD_REDIS_URL;
const NEW_REDIS_URL = process.env.NEW_REDIS_URL || process.env.REDIS_URL;

// Migration settings
const BATCH_SIZE = 100; // Keys to process in each batch
const SCAN_COUNT = 1000; // Keys to scan at once
const MIGRATION_PREFIX = 'migration:'; // Prefix for migration tracking

class RedisMigration {
  constructor(oldRedisUrl, newRedisUrl) {
    this.oldRedis = null;
    this.newRedis = null;
    this.oldRedisUrl = oldRedisUrl;
    this.newRedisUrl = newRedisUrl;
    
    this.stats = {
      totalKeys: 0,
      migratedKeys: 0,
      skippedKeys: 0,
      errorKeys: 0,
      startTime: Date.now(),
      keyTypes: {
        string: 0,
        hash: 0,
        list: 0,
        set: 0,
        zset: 0,
        stream: 0
      }
    };
  }

  async connect() {
    log.info('Connecting to Redis instances...');
    
    try {
      // Connect to old Redis
      this.oldRedis = new Redis(this.oldRedisUrl, {
        retryDelayOnFailover: 100,
        maxRetriesPerRequest: 3,
        commandTimeout: 30000
      });
      
      // Connect to new Redis
      this.newRedis = new Redis(this.newRedisUrl, {
        retryDelayOnFailover: 100,
        maxRetriesPerRequest: 3,
        commandTimeout: 30000
      });
      
      // Test connections
      await this.oldRedis.ping();
      await this.newRedis.ping();
      
      log.info('✅ Connected to both Redis instances');
      
      // Get Redis info
      const oldInfo = await this.oldRedis.info('server');
      const newInfo = await this.newRedis.info('server');
      
      log.info('Old Redis info:', { 
        version: this.extractVersion(oldInfo),
        url: this.maskUrl(this.oldRedisUrl)
      });
      log.info('New Redis info:', { 
        version: this.extractVersion(newInfo),
        url: this.maskUrl(this.newRedisUrl)
      });
      
    } catch (error) {
      log.error('Failed to connect to Redis instances', { error: error.message });
      throw error;
    }
  }

  extractVersion(info) {
    const match = info.match(/redis_version:([^\r\n]+)/);
    return match ? match[1] : 'unknown';
  }

  maskUrl(url) {
    return url.replace(/:\/\/[^@]+@/, '://***:***@');
  }

  async scanAllKeys() {
    log.info('Scanning all keys in old Redis...');
    
    const keys = [];
    let cursor = '0';
    
    do {
      const result = await this.oldRedis.scan(cursor, 'COUNT', SCAN_COUNT);
      cursor = result[0];
      const batchKeys = result[1];
      
      // Filter out migration tracking keys
      const filteredKeys = batchKeys.filter(key => !key.startsWith(MIGRATION_PREFIX));
      keys.push(...filteredKeys);
      
      if (keys.length % 1000 === 0) {
        log.info(`Scanned ${keys.length} keys so far...`);
      }
      
    } while (cursor !== '0');
    
    this.stats.totalKeys = keys.length;
    log.info(`Found ${keys.length} keys to migrate`);
    
    return keys;
  }

  async migrateKey(key) {
    try {
      // Check if key already exists in new Redis
      const exists = await this.newRedis.exists(key);
      if (exists) {
        log.debug(`Key ${key} already exists in new Redis, skipping`);
        this.stats.skippedKeys++;
        return;
      }
      
      // Get key type and TTL
      const type = await this.oldRedis.type(key);
      const ttl = await this.oldRedis.ttl(key);
      
      this.stats.keyTypes[type] = (this.stats.keyTypes[type] || 0) + 1;
      
      // Migrate based on key type
      switch (type) {
        case 'string':
          await this.migrateString(key, ttl);
          break;
        case 'hash':
          await this.migrateHash(key, ttl);
          break;
        case 'list':
          await this.migrateList(key, ttl);
          break;
        case 'set':
          await this.migrateSet(key, ttl);
          break;
        case 'zset':
          await this.migrateZSet(key, ttl);
          break;
        case 'stream':
          await this.migrateStream(key, ttl);
          break;
        default:
          log.warn(`Unknown key type: ${type} for key: ${key}`);
          this.stats.errorKeys++;
          return;
      }
      
      this.stats.migratedKeys++;
      
    } catch (error) {
      log.error(`Failed to migrate key: ${key}`, { error: error.message });
      this.stats.errorKeys++;
    }
  }

  async migrateString(key, ttl) {
    const value = await this.oldRedis.get(key);
    
    if (ttl > 0) {
      await this.newRedis.setex(key, ttl, value);
    } else {
      await this.newRedis.set(key, value);
    }
  }

  async migrateHash(key, ttl) {
    const hash = await this.oldRedis.hgetall(key);
    
    if (Object.keys(hash).length > 0) {
      await this.newRedis.hmset(key, hash);
      
      if (ttl > 0) {
        await this.newRedis.expire(key, ttl);
      }
    }
  }

  async migrateList(key, ttl) {
    const list = await this.oldRedis.lrange(key, 0, -1);
    
    if (list.length > 0) {
      await this.newRedis.lpush(key, ...list.reverse());
      
      if (ttl > 0) {
        await this.newRedis.expire(key, ttl);
      }
    }
  }

  async migrateSet(key, ttl) {
    const set = await this.oldRedis.smembers(key);
    
    if (set.length > 0) {
      await this.newRedis.sadd(key, ...set);
      
      if (ttl > 0) {
        await this.newRedis.expire(key, ttl);
      }
    }
  }

  async migrateZSet(key, ttl) {
    const zset = await this.oldRedis.zrange(key, 0, -1, 'WITHSCORES');
    
    if (zset.length > 0) {
      // Convert to score-member pairs
      const args = [];
      for (let i = 0; i < zset.length; i += 2) {
        args.push(zset[i + 1], zset[i]); // score, member
      }
      
      await this.newRedis.zadd(key, ...args);
      
      if (ttl > 0) {
        await this.newRedis.expire(key, ttl);
      }
    }
  }

  async migrateStream(key, ttl) {
    // Stream migration is complex, for now we'll skip streams
    log.warn(`Skipping stream key: ${key} (stream migration not implemented)`);
    this.stats.skippedKeys++;
  }

  async migrateBatch(keys) {
    const promises = keys.map(key => this.migrateKey(key));
    await Promise.all(promises);
  }

  async migrate() {
    try {
      await this.connect();
      
      // Scan all keys
      const keys = await this.scanAllKeys();
      
      if (keys.length === 0) {
        log.info('No keys found to migrate');
        return;
      }
      
      // Process keys in batches
      log.info(`Starting migration of ${keys.length} keys in batches of ${BATCH_SIZE}...`);
      
      for (let i = 0; i < keys.length; i += BATCH_SIZE) {
        const batch = keys.slice(i, i + BATCH_SIZE);
        
        log.info(`Migrating batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(keys.length / BATCH_SIZE)} (${batch.length} keys)`);
        
        await this.migrateBatch(batch);
        
        // Progress update
        const progress = ((i + batch.length) / keys.length * 100).toFixed(1);
        log.info(`Progress: ${progress}% (${this.stats.migratedKeys} migrated, ${this.stats.skippedKeys} skipped, ${this.stats.errorKeys} errors)`);
        
        // Small delay to avoid overwhelming Redis
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      // Final verification
      await this.verifyMigration();
      
    } catch (error) {
      log.error('Migration failed', { error: error.message });
      throw error;
    } finally {
      await this.disconnect();
    }
  }

  async verifyMigration() {
    log.info('Verifying migration...');
    
    try {
      // Count keys in both Redis instances
      const oldKeyCount = await this.oldRedis.dbsize();
      const newKeyCount = await this.newRedis.dbsize();
      
      log.info('Migration verification:', {
        oldRedisKeys: oldKeyCount,
        newRedisKeys: newKeyCount,
        migratedKeys: this.stats.migratedKeys,
        skippedKeys: this.stats.skippedKeys,
        errorKeys: this.stats.errorKeys
      });
      
      // Sample verification - check a few random keys
      const sampleKeys = await this.oldRedis.randomkey();
      if (sampleKeys) {
        const oldValue = await this.oldRedis.get(sampleKeys);
        const newValue = await this.newRedis.get(sampleKeys);
        
        if (oldValue === newValue) {
          log.info('✅ Sample key verification passed');
        } else {
          log.warn('⚠️ Sample key verification failed', { key: sampleKeys });
        }
      }
      
    } catch (error) {
      log.error('Verification failed', { error: error.message });
    }
  }

  async disconnect() {
    if (this.oldRedis) {
      await this.oldRedis.quit();
    }
    if (this.newRedis) {
      await this.newRedis.quit();
    }
    log.info('Disconnected from Redis instances');
  }

  printStats() {
    const duration = Date.now() - this.stats.startTime;
    const durationSec = Math.round(duration / 1000);
    
    console.log('\n' + '='.repeat(60));
    console.log('🎉 MIGRATION COMPLETED');
    console.log('='.repeat(60));
    console.log(`📊 Total Keys Found: ${this.stats.totalKeys}`);
    console.log(`✅ Successfully Migrated: ${this.stats.migratedKeys}`);
    console.log(`⏭️  Skipped (already exist): ${this.stats.skippedKeys}`);
    console.log(`❌ Errors: ${this.stats.errorKeys}`);
    console.log(`⏱️  Duration: ${durationSec} seconds`);
    console.log(`🚀 Rate: ${Math.round(this.stats.migratedKeys / durationSec)} keys/sec`);
    console.log('\n📈 Key Types Migrated:');
    Object.entries(this.stats.keyTypes).forEach(([type, count]) => {
      if (count > 0) {
        console.log(`   ${type}: ${count}`);
      }
    });
    console.log('='.repeat(60));
  }
}

async function main() {
  console.log('🔄 Redis Data Migration Tool');
  console.log('============================\n');
  
  // Validate environment variables
  if (!OLD_REDIS_URL) {
    console.error('❌ OLD_REDIS_URL environment variable is required');
    console.error('   Set it to your old Railway Redis URL');
    process.exit(1);
  }
  
  if (!NEW_REDIS_URL) {
    console.error('❌ NEW_REDIS_URL or REDIS_URL environment variable is required');
    console.error('   Set it to your new Railway Redis URL');
    process.exit(1);
  }
  
  console.log('📋 Migration Configuration:');
  console.log(`   Old Redis: ${OLD_REDIS_URL.replace(/:\/\/[^@]+@/, '://***:***@')}`);
  console.log(`   New Redis: ${NEW_REDIS_URL.replace(/:\/\/[^@]+@/, '://***:***@')}`);
  console.log(`   Batch Size: ${BATCH_SIZE} keys`);
  console.log('');
  
  // Confirm migration
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  const answer = await new Promise(resolve => {
    rl.question('⚠️  This will copy all data from old Redis to new Redis. Continue? (y/N): ', resolve);
  });
  
  rl.close();
  
  if (answer.toLowerCase() !== 'y') {
    console.log('Migration cancelled');
    process.exit(0);
  }
  
  // Start migration
  const migration = new RedisMigration(OLD_REDIS_URL, NEW_REDIS_URL);
  
  try {
    await migration.migrate();
    migration.printStats();
    
    console.log('\n✅ Migration completed successfully!');
    console.log('🔍 Verify your application works with the new Redis URL');
    console.log('🗑️  You can safely delete the old Redis instance after verification');
    
  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    migration.printStats();
    process.exit(1);
  }
}

// Run migration
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { RedisMigration };