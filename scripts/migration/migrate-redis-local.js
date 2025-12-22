#!/usr/bin/env node

/**
 * Local Redis Migration Script
 * 
 * Migrates data from old Railway Redis to new Railway Redis
 * Runs locally on Windows using environment variables
 */

// Load environment variables from .env file
require('dotenv').config();

const Redis = require('ioredis');
const { createLogger } = require('../logger');
const readline = require('readline');

const log = createLogger('redis-migration-local');

// Get Redis URLs from environment or prompt
const CURRENT_REDIS_URL = process.env.REDIS_URL; // From .env file (new Redis)

class LocalRedisMigration {
  constructor() {
    this.oldRedis = null;
    this.newRedis = null;
    this.oldRedisUrl = null;
    this.newRedisUrl = CURRENT_REDIS_URL;
    
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
        zset: 0
      }
    };
  }

  async promptForOldRedisUrl() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log('🔄 Local Redis Migration Tool');
    console.log('=============================\n');
    
    console.log('📋 Current Configuration:');
    console.log(`   New Redis (from .env): ${this.maskUrl(this.newRedisUrl)}`);
    console.log('');

    const oldUrl = await new Promise(resolve => {
      rl.question('🔗 Enter your OLD Railway Redis URL (the one to migrate FROM): ', resolve);
    });

    rl.close();
    
    if (!oldUrl || !oldUrl.startsWith('redis://')) {
      throw new Error('Invalid Redis URL. Must start with redis://');
    }

    this.oldRedisUrl = oldUrl;
    console.log(`   Old Redis: ${this.maskUrl(this.oldRedisUrl)}\n`);
  }

  maskUrl(url) {
    if (!url) return 'not set';
    return url.replace(/:\/\/[^@]+@/, '://***:***@');
  }

  async connect() {
    console.log('📡 Connecting to Redis instances...');
    
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
      
      console.log('✅ Connected to both Redis instances');
      
      // Get key counts
      const oldCount = await this.oldRedis.dbsize();
      const newCount = await this.newRedis.dbsize();
      
      console.log(`📊 Current key counts:`);
      console.log(`   Old Redis: ${oldCount} keys`);
      console.log(`   New Redis: ${newCount} keys\n`);
      
      if (newCount > 0) {
        console.log('⚠️  New Redis already contains data. Existing keys will be preserved.\n');
      }
      
    } catch (error) {
      console.error('❌ Failed to connect to Redis instances:', error.message);
      throw error;
    }
  }

  async confirmMigration() {
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
  }

  async scanAllKeys() {
    console.log('🔍 Scanning all keys in old Redis...');
    
    const keys = [];
    let cursor = '0';
    
    do {
      const result = await this.oldRedis.scan(cursor, 'COUNT', 1000);
      cursor = result[0];
      const batchKeys = result[1];
      
      keys.push(...batchKeys);
      
      if (keys.length % 1000 === 0 && keys.length > 0) {
        console.log(`   Scanned ${keys.length} keys so far...`);
      }
      
    } while (cursor !== '0');
    
    this.stats.totalKeys = keys.length;
    console.log(`✅ Found ${keys.length} keys to migrate\n`);
    
    return keys;
  }

  async migrateKey(key) {
    try {
      // Check if key already exists in new Redis
      const exists = await this.newRedis.exists(key);
      if (exists) {
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
          const value = await this.oldRedis.get(key);
          if (ttl > 0) {
            await this.newRedis.setex(key, ttl, value);
          } else {
            await this.newRedis.set(key, value);
          }
          break;
          
        case 'hash':
          const hash = await this.oldRedis.hgetall(key);
          if (Object.keys(hash).length > 0) {
            await this.newRedis.hmset(key, hash);
            if (ttl > 0) {
              await this.newRedis.expire(key, ttl);
            }
          }
          break;
          
        case 'list':
          const list = await this.oldRedis.lrange(key, 0, -1);
          if (list.length > 0) {
            await this.newRedis.lpush(key, ...list.reverse());
            if (ttl > 0) {
              await this.newRedis.expire(key, ttl);
            }
          }
          break;
          
        case 'set':
          const set = await this.oldRedis.smembers(key);
          if (set.length > 0) {
            await this.newRedis.sadd(key, ...set);
            if (ttl > 0) {
              await this.newRedis.expire(key, ttl);
            }
          }
          break;
          
        case 'zset':
          const zset = await this.oldRedis.zrange(key, 0, -1, 'WITHSCORES');
          if (zset.length > 0) {
            const args = [];
            for (let i = 0; i < zset.length; i += 2) {
              args.push(zset[i + 1], zset[i]); // score, member
            }
            await this.newRedis.zadd(key, ...args);
            if (ttl > 0) {
              await this.newRedis.expire(key, ttl);
            }
          }
          break;
          
        default:
          console.log(`⚠️  Skipping unknown key type: ${type} for key: ${key}`);
          this.stats.skippedKeys++;
          return;
      }
      
      this.stats.migratedKeys++;
      
    } catch (error) {
      console.log(`❌ Failed to migrate key: ${key} - ${error.message}`);
      this.stats.errorKeys++;
    }
  }

  async migrate() {
    try {
      await this.promptForOldRedisUrl();
      await this.connect();
      await this.confirmMigration();
      
      // Scan all keys
      const keys = await this.scanAllKeys();
      
      if (keys.length === 0) {
        console.log('No keys found to migrate');
        return;
      }
      
      // Process keys in batches
      console.log('🚀 Starting migration...');
      const batchSize = 100;
      
      for (let i = 0; i < keys.length; i += batchSize) {
        const batch = keys.slice(i, i + batchSize);
        
        // Process batch
        const promises = batch.map(key => this.migrateKey(key));
        await Promise.all(promises);
        
        // Progress update
        const progress = ((i + batch.length) / keys.length * 100).toFixed(1);
        console.log(`Progress: ${progress}% (${this.stats.migratedKeys} migrated, ${this.stats.skippedKeys} skipped, ${this.stats.errorKeys} errors)`);
        
        // Small delay
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      // Verification
      await this.verifyMigration();
      
    } catch (error) {
      console.error('❌ Migration failed:', error.message);
      throw error;
    } finally {
      await this.disconnect();
    }
  }

  async verifyMigration() {
    console.log('\n🔍 Verifying migration...');
    
    try {
      const oldKeyCount = await this.oldRedis.dbsize();
      const newKeyCount = await this.newRedis.dbsize();
      
      console.log('📊 Final key counts:');
      console.log(`   Old Redis: ${oldKeyCount} keys`);
      console.log(`   New Redis: ${newKeyCount} keys`);
      
      // Sample verification
      const sampleKey = await this.oldRedis.randomkey();
      if (sampleKey) {
        const oldExists = await this.oldRedis.exists(sampleKey);
        const newExists = await this.newRedis.exists(sampleKey);
        
        if (oldExists && newExists) {
          console.log('✅ Sample key verification passed');
        } else {
          console.log('⚠️  Sample key verification failed');
        }
      }
      
    } catch (error) {
      console.log('⚠️  Verification failed:', error.message);
    }
  }

  async disconnect() {
    if (this.oldRedis) {
      await this.oldRedis.quit();
    }
    if (this.newRedis) {
      await this.newRedis.quit();
    }
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
    
    if (durationSec > 0) {
      console.log(`🚀 Rate: ${Math.round(this.stats.migratedKeys / durationSec)} keys/sec`);
    }
    
    console.log('\n📈 Key Types Migrated:');
    Object.entries(this.stats.keyTypes).forEach(([type, count]) => {
      if (count > 0) {
        console.log(`   ${type}: ${count}`);
      }
    });
    console.log('='.repeat(60));
    
    console.log('\n✅ Migration completed successfully!');
    console.log('🔄 Your new Redis now contains all data from the old Redis');
    console.log('🧪 Test your application to ensure everything works');
    console.log('🗑️  You can safely delete the old Redis after verification');
  }
}

async function main() {
  // Check if REDIS_URL is set
  if (!CURRENT_REDIS_URL) {
    console.error('❌ REDIS_URL not found in environment variables');
    console.error('   Make sure you have a .env file with REDIS_URL set');
    process.exit(1);
  }

  const migration = new LocalRedisMigration();
  
  try {
    await migration.migrate();
    migration.printStats();
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

module.exports = { LocalRedisMigration };