#!/usr/bin/env node

/**
 * Fix Redis data type conflicts and clean up problematic keys
 */

const { getRedisClient } = require('./shared/redis/client');
const { createLogger } = require('./logger');

const log = createLogger('fix-redis');

async function fixRedisData() {
  const redis = getRedisClient();
  
  try {
    await redis.connect();
    log.info('Connected to Redis');
    
    // Clear all potentially problematic keys
    const problematicPatterns = [
      'progress:*',
      'coordinator:*',
      'job:*',
      'worker:*',
      'forward:*'
    ];
    
    let totalDeleted = 0;
    
    for (const pattern of problematicPatterns) {
      log.info(`Scanning pattern: ${pattern}`);
      const keys = await redis.executeCommand('keys', pattern);
      
      if (keys.length > 0) {
        log.info(`Found ${keys.length} keys matching ${pattern}`);
        
        // Delete in batches to avoid blocking Redis
        const batchSize = 100;
        for (let i = 0; i < keys.length; i += batchSize) {
          const batch = keys.slice(i, i + batchSize);
          const deleted = await redis.executeCommand('del', ...batch);
          totalDeleted += deleted;
          log.info(`Deleted ${deleted} keys (batch ${Math.floor(i/batchSize) + 1})`);
        }
      }
    }
    
    log.info(`Redis cleanup completed. Deleted ${totalDeleted} keys total.`);
    
    // Test basic operations
    await redis.executeCommand('set', 'test:cleanup', 'success');
    const testResult = await redis.executeCommand('get', 'test:cleanup');
    await redis.executeCommand('del', 'test:cleanup');
    
    if (testResult === 'success') {
      log.info('Redis is working correctly after cleanup');
    } else {
      log.error('Redis test failed after cleanup');
    }
    
  } catch (error) {
    log.error('Error during Redis cleanup:', error.message);
    throw error;
  } finally {
    await redis.close();
  }
}

if (require.main === module) {
  fixRedisData().catch(error => {
    console.error('Failed to fix Redis data:', error.message);
    process.exit(1);
  });
}

module.exports = { fixRedisData };