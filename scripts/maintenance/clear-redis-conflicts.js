#!/usr/bin/env node

/**
 * Clear Redis data type conflicts
 * This script identifies and clears keys that might have wrong data types
 */

const { getRedisClient } = require('./shared/redis/client');
const { createLogger } = require('./logger');

const log = createLogger('clear-redis');

async function clearRedisConflicts() {
  const redis = getRedisClient();
  
  try {
    await redis.connect();
    log.info('Connected to Redis');
    
    // Check for problematic keys that might have wrong data types
    const patterns = [
      'progress:*',
      'progress:*:count',
      'progress:*:counts',
      'progress:*:valid',
      'coordinator:*',
      'job:*'
    ];
    
    for (const pattern of patterns) {
      log.info(`Scanning pattern: ${pattern}`);
      const keys = await redis.executeCommand('keys', pattern);
      
      for (const key of keys) {
        try {
          // Check key type
          const type = await redis.executeCommand('type', key);
          log.info(`Key: ${key}, Type: ${type}`);
          
          // If it's not a string type and we expect string, delete it
          if (type !== 'string' && (key.includes('progress:') || key.includes('coordinator:'))) {
            log.warn(`Deleting key with wrong type: ${key} (${type})`);
            await redis.executeCommand('del', key);
          }
        } catch (error) {
          log.error(`Error checking key ${key}:`, error.message);
          // Delete problematic keys
          await redis.executeCommand('del', key);
        }
      }
    }
    
    log.info('Redis conflict cleanup completed');
    
  } catch (error) {
    log.error('Error during cleanup:', error.message);
  } finally {
    await redis.close();
  }
}

clearRedisConflicts().catch(console.error);