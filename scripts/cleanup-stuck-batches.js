#!/usr/bin/env node
/**
 * Cleanup Stuck Batches Script
 * 
 * Cleans up stuck batch data from Redis when batches can't be stopped normally.
 * Use this when you have orphaned batches from crashed coordinator sessions.
 */

require('dotenv').config();
const { getRedisClient } = require('../shared/redis/client');
const { createLogger } = require('../logger');

const log = createLogger('cleanup');

async function cleanupStuckBatches() {
  let redisClient;
  
  try {
    log.info('Starting stuck batch cleanup...');
    
    // Connect to Redis
    redisClient = getRedisClient();
    await redisClient.connect();
    
    log.info('Connected to Redis, scanning for batch data...');
    
    // Find all progress tracker keys
    const progressKeys = await redisClient.executeCommand('keys', 'progress:*');
    log.info(`Found ${progressKeys.length} progress tracker entries`);
    
    // Find all batch cancellation keys
    const cancelKeys = await redisClient.executeCommand('keys', 'batch:*:cancelled');
    log.info(`Found ${cancelKeys.length} batch cancellation entries`);
    
    // Find all task lease keys
    const leaseKeys = await redisClient.executeCommand('keys', 'job:*');
    log.info(`Found ${leaseKeys.length} task lease entries`);
    
    // Find all result count keys
    const countKeys = await redisClient.executeCommand('keys', 'progress:*:count*');
    log.info(`Found ${countKeys.length} progress count entries`);
    
    // Find all valid credential keys
    const validKeys = await redisClient.executeCommand('keys', 'progress:*:valid');
    log.info(`Found ${validKeys.length} valid credential entries`);
    
    // Find queue entries
    const mainQueueLength = await redisClient.executeCommand('llen', 'queue:tasks');
    const retryQueueLength = await redisClient.executeCommand('llen', 'queue:retry');
    log.info(`Queue lengths - Main: ${mainQueueLength}, Retry: ${retryQueueLength}`);
    
    // Collect all keys to delete
    const allKeys = [
      ...progressKeys,
      ...cancelKeys, 
      ...leaseKeys,
      ...countKeys,
      ...validKeys
    ];
    
    if (allKeys.length === 0 && mainQueueLength === 0 && retryQueueLength === 0) {
      log.info('No stuck batch data found - Redis is clean!');
      return;
    }
    
    log.warn(`Found ${allKeys.length} keys to delete and ${mainQueueLength + retryQueueLength} queued tasks`);
    
    // Ask for confirmation
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    const answer = await new Promise(resolve => {
      rl.question('Do you want to delete all stuck batch data? (y/N): ', resolve);
    });
    rl.close();
    
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      log.info('Cleanup cancelled by user');
      return;
    }
    
    log.info('Starting cleanup...');
    
    // Delete all batch-related keys
    if (allKeys.length > 0) {
      // Delete in batches to avoid overwhelming Redis
      const batchSize = 100;
      for (let i = 0; i < allKeys.length; i += batchSize) {
        const batch = allKeys.slice(i, i + batchSize);
        await redisClient.executeCommand('del', ...batch);
        log.info(`Deleted batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(allKeys.length/batchSize)} (${batch.length} keys)`);
      }
    }
    
    // Clear job queues
    if (mainQueueLength > 0) {
      await redisClient.executeCommand('del', 'queue:tasks');
      log.info(`Cleared main queue (${mainQueueLength} tasks)`);
    }
    
    if (retryQueueLength > 0) {
      await redisClient.executeCommand('del', 'queue:retry');
      log.info(`Cleared retry queue (${retryQueueLength} tasks)`);
    }
    
    // Clear coordinator heartbeat to prevent conflicts
    await redisClient.executeCommand('del', 'coordinator:heartbeat');
    log.info('Cleared coordinator heartbeat');
    
    // Clear any worker heartbeats
    const workerHeartbeats = await redisClient.executeCommand('keys', 'worker:*:heartbeat');
    if (workerHeartbeats.length > 0) {
      await redisClient.executeCommand('del', ...workerHeartbeats);
      log.info(`Cleared ${workerHeartbeats.length} worker heartbeats`);
    }
    
    log.success('✅ Cleanup completed successfully!');
    log.info('You can now restart the bot - it should start clean without stuck batches');
    
  } catch (error) {
    log.error('Cleanup failed:', error.message);
    process.exit(1);
  } finally {
    if (redisClient) {
      await redisClient.close();
    }
  }
}

// Run cleanup if called directly
if (require.main === module) {
  cleanupStuckBatches()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { cleanupStuckBatches };