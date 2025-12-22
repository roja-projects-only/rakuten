#!/usr/bin/env node
/**
 * =============================================================================
 * MIGRATE REDIS TTL - One-time migration to update TTL to 30 days
 * =============================================================================
 * 
 * Usage: node scripts/migrate-redis-ttl.js
 * 
 * This script:
 * 1. Scans all proc:* keys in Redis
 * 2. Updates TTL to 30 days for keys with shorter TTL
 * 3. Reports migration stats
 * 
 * =============================================================================
 */

require('dotenv').config();

const Redis = require('ioredis');

const NEW_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const BATCH_SIZE = 100;

async function migrate() {
  const url = process.env.REDIS_URL;
  
  if (!url) {
    console.error('❌ REDIS_URL not set in environment');
    process.exit(1);
  }
  
  console.log('🔄 Connecting to Redis...');
  const redis = new Redis(url);
  
  try {
    let cursor = '0';
    let scanned = 0;
    let updated = 0;
    let skipped = 0;
    
    console.log(`📊 Target TTL: ${NEW_TTL_SECONDS} seconds (30 days)`);
    console.log('🔍 Scanning proc:* keys...\n');
    
    do {
      // Scan for proc:* keys
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'proc:*', 'COUNT', BATCH_SIZE);
      cursor = nextCursor;
      
      if (keys.length === 0) continue;
      
      // Get current TTLs
      const pipeline = redis.pipeline();
      for (const key of keys) {
        pipeline.ttl(key);
      }
      const ttls = await pipeline.exec();
      
      // Update keys with shorter TTL
      const updatePipeline = redis.pipeline();
      let batchUpdates = 0;
      
      for (let i = 0; i < keys.length; i++) {
        scanned++;
        const key = keys[i];
        const ttl = ttls[i][1];
        
        // TTL of -1 means no expiry, -2 means key doesn't exist
        if (ttl === -2) continue;
        
        if (ttl === -1 || ttl < NEW_TTL_SECONDS) {
          updatePipeline.expire(key, NEW_TTL_SECONDS);
          batchUpdates++;
          updated++;
        } else {
          skipped++;
        }
      }
      
      if (batchUpdates > 0) {
        await updatePipeline.exec();
      }
      
      // Progress
      process.stdout.write(`\r  Scanned: ${scanned} | Updated: ${updated} | Skipped: ${skipped}`);
      
    } while (cursor !== '0');
    
    console.log('\n');
    
    // Also scan fwd:* and msg:* keys
    for (const pattern of ['fwd:*', 'msg:*']) {
      cursor = '0';
      let patternUpdated = 0;
      
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', BATCH_SIZE);
        cursor = nextCursor;
        
        if (keys.length === 0) continue;
        
        const pipeline = redis.pipeline();
        for (const key of keys) {
          pipeline.ttl(key);
        }
        const ttls = await pipeline.exec();
        
        const updatePipeline = redis.pipeline();
        
        for (let i = 0; i < keys.length; i++) {
          const ttl = ttls[i][1];
          if (ttl === -2) continue;
          
          if (ttl === -1 || ttl < NEW_TTL_SECONDS) {
            updatePipeline.expire(keys[i], NEW_TTL_SECONDS);
            patternUpdated++;
          }
        }
        
        await updatePipeline.exec();
        
      } while (cursor !== '0');
      
      if (patternUpdated > 0) {
        console.log(`  ${pattern}: Updated ${patternUpdated} keys`);
      }
    }
    
    console.log('\n✅ Migration complete!');
    console.log(`   Total scanned: ${scanned}`);
    console.log(`   Updated to 30-day TTL: ${updated}`);
    console.log(`   Already >= 30 days: ${skipped}`);
    
  } catch (err) {
    console.error(`\n❌ Migration failed: ${err.message}`);
    process.exit(1);
  } finally {
    await redis.quit();
  }
}

migrate();
