#!/usr/bin/env node

/**
 * Worker Integration Test
 * 
 * Tests the WorkerNode integration with Redis and basic functionality.
 * This is a simple integration test that doesn't require Jest.
 */

const { createLogger } = require('../logger');
const { initRedisClient } = require('../shared/redis/client');
const WorkerNode = require('../shared/worker/WorkerNode');

const log = createLogger('worker-integration-test');

async function testWorkerIntegration() {
  log.info('Starting worker integration test');
  
  try {
    // Test 1: Redis Connection
    log.info('Test 1: Testing Redis connection...');
    
    if (!process.env.REDIS_URL) {
      log.warn('REDIS_URL not set, skipping Redis tests');
      log.info('✓ Worker integration test completed (Redis tests skipped)');
      return;
    }
    
    const redisClient = await initRedisClient();
    const isHealthy = await redisClient.isHealthy();
    
    if (!isHealthy) {
      throw new Error('Redis connection is not healthy');
    }
    
    log.info('✓ Redis connection successful');
    
    // Test 2: Worker Creation
    log.info('Test 2: Testing WorkerNode creation...');
    
    const worker = new WorkerNode(redisClient, {
      workerId: 'test-worker-integration',
      heartbeatInterval: 5000,
      queueTimeout: 2000
    });
    
    log.info('✓ WorkerNode created successfully');
    
    // Test 3: Worker Registration
    log.info('Test 3: Testing worker registration...');
    
    await worker.registerWorker();
    
    log.info('✓ Worker registration successful');
    
    // Test 4: Heartbeat
    log.info('Test 4: Testing heartbeat mechanism...');
    
    await worker.sendHeartbeat();
    
    log.info('✓ Heartbeat sent successfully');
    
    // Test 5: Task Dequeue (should timeout quickly)
    log.info('Test 5: Testing task dequeue (should timeout)...');
    
    const task = await worker.dequeueTask();
    
    if (task === null) {
      log.info('✓ Task dequeue timeout as expected (no tasks in queue)');
    } else {
      log.warn('Unexpected task found in queue:', task);
    }
    
    // Test 6: Cleanup
    log.info('Test 6: Testing cleanup...');
    
    await worker.cleanup();
    await redisClient.close();
    
    log.info('✓ Cleanup successful');
    
    log.info('🎉 All worker integration tests passed!');
    
  } catch (error) {
    log.error('❌ Worker integration test failed', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Run the test
if (require.main === module) {
  testWorkerIntegration().catch((error) => {
    log.error('Fatal error in integration test', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  });
}

module.exports = { testWorkerIntegration };