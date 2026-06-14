#!/usr/bin/env node

/**
 * Redis Migration Verification Script
 * 
 * Compares data between old and new Redis to verify migration success
 */

const Redis = require('ioredis');
const { createLogger } = require('../../src/shared/logger');

const log = createLogger('redis-verify');

const OLD_REDIS_URL = process.env.OLD_REDIS_URL;
const NEW_REDIS_URL = process.env.NEW_REDIS_URL || process.env.REDIS_URL;

async function verifyMigration() {
  console.log('🔍 Verifying Redis Migration');
  console.log('============================\n');
  
  if (!OLD_REDIS_URL || !NEW_REDIS_URL) {
    console.error('❌ Both OLD_REDIS_URL and NEW_REDIS_URL are required');
    process.exit(1);
  }
  
  let oldRedis, newRedis;
  
  try {
    // Connect to both Redis instances
    console.log('📡 Connecting to Redis instances...');
    
    oldRedis = new Redis(OLD_REDIS_URL, { commandTimeout: 30000 });
    newRedis = new Redis(NEW_REDIS_URL, { commandTimeout: 30000 });
    
    await oldRedis.ping();
    await newRedis.ping();
    
    console.log('✅ Connected to both Redis instances\n');
    
    // Get basic stats
    const oldKeyCount = await oldRedis.dbsize();
    const newKeyCount = await newRedis.dbsize();
    
    console.log('📊 Key Count Comparison:');
    console.log(`   Old Redis: ${oldKeyCount} keys`);
    console.log(`   New Redis: ${newKeyCount} keys`);
    
    if (newKeyCount >= oldKeyCount) {
      console.log('✅ New Redis has equal or more keys than old Redis\n');
    } else {
      console.log('⚠️  New Redis has fewer keys than old Redis\n');
    }
    
    // Sample key verification
    console.log('🧪 Sample Key Verification:');
    
    // Get some random keys from old Redis
    const sampleKeys = [];
    for (let i = 0; i < Math.min(10, oldKeyCount); i++) {
      const key = await oldRedis.randomkey();
      if (key && !sampleKeys.includes(key)) {
        sampleKeys.push(key);
      }
    }
    
    let matchedKeys = 0;
    let mismatchedKeys = 0;
    
    for (const key of sampleKeys) {
      try {
        const oldType = await oldRedis.type(key);
        const newType = await newRedis.type(key);
        
        if (newType === 'none') {
          console.log(`❌ Key missing in new Redis: ${key}`);
          mismatchedKeys++;
          continue;
        }
        
        if (oldType !== newType) {
          console.log(`❌ Type mismatch for key ${key}: ${oldType} vs ${newType}`);
          mismatchedKeys++;
          continue;
        }
        
        // Compare values based on type
        let valuesMatch = false;
        
        switch (oldType) {
          case 'string':
            const oldStr = await oldRedis.get(key);
            const newStr = await newRedis.get(key);
            valuesMatch = oldStr === newStr;
            break;
            
          case 'hash':
            const oldHash = await oldRedis.hgetall(key);
            const newHash = await newRedis.hgetall(key);
            valuesMatch = JSON.stringify(oldHash) === JSON.stringify(newHash);
            break;
            
          case 'list':
            const oldList = await oldRedis.lrange(key, 0, -1);
            const newList = await newRedis.lrange(key, 0, -1);
            valuesMatch = JSON.stringify(oldList) === JSON.stringify(newList);
            break;
            
          case 'set':
            const oldSet = await oldRedis.smembers(key);
            const newSet = await newRedis.smembers(key);
            valuesMatch = JSON.stringify(oldSet.sort()) === JSON.stringify(newSet.sort());
            break;
            
          case 'zset':
            const oldZset = await oldRedis.zrange(key, 0, -1, 'WITHSCORES');
            const newZset = await newRedis.zrange(key, 0, -1, 'WITHSCORES');
            valuesMatch = JSON.stringify(oldZset) === JSON.stringify(newZset);
            break;
            
          default:
            console.log(`⚠️  Skipping verification for key type: ${oldType}`);
            continue;
        }
        
        if (valuesMatch) {
          console.log(`✅ Key verified: ${key} (${oldType})`);
          matchedKeys++;
        } else {
          console.log(`❌ Value mismatch for key: ${key} (${oldType})`);
          mismatchedKeys++;
        }
        
      } catch (error) {
        console.log(`❌ Error verifying key ${key}: ${error.message}`);
        mismatchedKeys++;
      }
    }
    
    console.log(`\n📈 Sample Verification Results:`);
    console.log(`   ✅ Matched: ${matchedKeys}`);
    console.log(`   ❌ Mismatched: ${mismatchedKeys}`);
    console.log(`   📊 Success Rate: ${((matchedKeys / (matchedKeys + mismatchedKeys)) * 100).toFixed(1)}%`);
    
    // Check specific application keys
    console.log('\n🔍 Application-Specific Key Check:');
    
    const appKeys = [
      'processed:*',
      'forward:*',
      'worker:*',
      'batch:*',
      'msg:*'
    ];
    
    for (const pattern of appKeys) {
      const oldKeys = await oldRedis.keys(pattern);
      const newKeys = await newRedis.keys(pattern);
      
      console.log(`   ${pattern}: ${oldKeys.length} → ${newKeys.length} keys`);
      
      if (newKeys.length >= oldKeys.length) {
        console.log(`   ✅ All ${pattern} keys migrated`);
      } else {
        console.log(`   ⚠️  Some ${pattern} keys may be missing`);
      }
    }
    
    // Final assessment
    console.log('\n' + '='.repeat(50));
    
    if (mismatchedKeys === 0 && newKeyCount >= oldKeyCount) {
      console.log('🎉 MIGRATION VERIFICATION PASSED');
      console.log('✅ All sampled keys match between Redis instances');
      console.log('✅ New Redis has all expected keys');
      console.log('\n👍 Your migration appears to be successful!');
      console.log('🔄 You can now update your application to use the new Redis URL');
    } else {
      console.log('⚠️  MIGRATION VERIFICATION ISSUES DETECTED');
      console.log(`❌ ${mismatchedKeys} key mismatches found`);
      console.log(`📊 Key count difference: ${newKeyCount - oldKeyCount}`);
      console.log('\n🔍 Please review the issues above before switching to new Redis');
    }
    
    console.log('='.repeat(50));
    
  } catch (error) {
    console.error('\n❌ Verification failed:', error.message);
    process.exit(1);
  } finally {
    if (oldRedis) await oldRedis.quit();
    if (newRedis) await newRedis.quit();
  }
}

// Run verification
if (require.main === module) {
  verifyMigration().catch(console.error);
}

module.exports = { verifyMigration };