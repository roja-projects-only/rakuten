#!/usr/bin/env node
/**
 * Emergency Redis Queue Cleaner
 * Clears stuck batch processing queues immediately
 */

const Redis = require('ioredis');

const REDIS_URL = 'redis://default:AxyIJiltXdrbkgpvhoexVgNBIRzlrXpU@hopper.proxy.rlwy.net:36224';

async function emergencyClear() {
  console.log('🚨 Emergency Redis Queue Cleaner');
  console.log('Connecting to Redis...');
  
  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 100,
    lazyConnect: true,
  });

  try {
    await redis.connect();
    console.log('✅ Connected to Redis');

    // Get queue lengths before clearing
    const mainQueueLength = await redis.llen('queue:tasks');
    const retryQueueLength = await redis.llen('queue:retry');
    
    console.log(`📊 Current queue status:`);
    console.log(`   Main queue: ${mainQueueLength} tasks`);
    console.log(`   Retry queue: ${retryQueueLength} tasks`);

    if (mainQueueLength === 0 && retryQueueLength === 0) {
      console.log('✅ Queues are already empty');
      return;
    }

    // Clear all queues and batch markers
    console.log('🧹 Clearing queues...');
    
    const pipeline = redis.pipeline();
    
    // Clear main queues
    pipeline.del('queue:tasks');
    pipeline.del('queue:retry');
    
    // Clear any batch cancellation markers
    const batchKeys = await redis.keys('batch:*:cancelled');
    if (batchKeys.length > 0) {
      console.log(`🗑️  Clearing ${batchKeys.length} batch cancellation markers`);
      pipeline.del(...batchKeys);
    }
    
    // Clear any stuck progress trackers
    const progressKeys = await redis.keys('progress:*');
    if (progressKeys.length > 0) {
      console.log(`🗑️  Clearing ${progressKeys.length} progress trackers`);
      pipeline.del(...progressKeys);
    }
    
    // Clear any task leases
    const leaseKeys = await redis.keys('job:*');
    if (leaseKeys.length > 0) {
      console.log(`🗑️  Clearing ${leaseKeys.length} task leases`);
      pipeline.del(...leaseKeys);
    }

    // Execute all deletions
    await pipeline.exec();
    
    console.log('✅ Emergency clear completed!');
    console.log(`   Cleared ${mainQueueLength + retryQueueLength} queued tasks`);
    console.log(`   Cleared ${batchKeys.length} batch markers`);
    console.log(`   Cleared ${progressKeys.length} progress trackers`);
    console.log(`   Cleared ${leaseKeys.length} task leases`);
    
    // Verify queues are empty
    const newMainLength = await redis.llen('queue:tasks');
    const newRetryLength = await redis.llen('queue:retry');
    
    if (newMainLength === 0 && newRetryLength === 0) {
      console.log('✅ Verification: All queues are now empty');
    } else {
      console.log('⚠️  Warning: Some tasks may still remain');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await redis.quit();
    console.log('🔌 Disconnected from Redis');
  }
}

// Run the emergency clear
emergencyClear()
  .then(() => {
    console.log('🎉 Emergency clear successful! You can now restart your coordinator.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Emergency clear failed:', error.message);
    process.exit(1);
  });