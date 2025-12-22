#!/usr/bin/env node

/**
 * Worker Task Processing Test
 * 
 * End-to-end test to verify that worker nodes can successfully process tasks.
 * This test validates the complete workflow from task enqueue to result storage.
 */

const { createLogger } = require('../logger');
const { initRedisClient } = require('../shared/redis/client');
const WorkerNode = require('../shared/worker/WorkerNode');
const JobQueueManager = require('../shared/coordinator/JobQueueManager');
const ProxyPoolManager = require('../shared/coordinator/ProxyPoolManager');

const log = createLogger('worker-task-processing-test');

async function testWorkerTaskProcessing() {
  log.info('Starting worker task processing test');
  
  let redisClient = null;
  let worker = null;
  
  try {
    // Test 1: Setup Redis Connection
    log.info('Test 1: Setting up Redis connection...');
    
    if (!process.env.REDIS_URL) {
      log.warn('REDIS_URL not set, skipping task processing test');
      log.info('✓ Worker task processing test completed (Redis tests skipped)');
      return;
    }
    
    redisClient = await initRedisClient();
    const isHealthy = await redisClient.isHealthy();
    
    if (!isHealthy) {
      throw new Error('Redis connection is not healthy');
    }
    
    log.info('✓ Redis connection established');
    
    // Test 2: Setup Job Queue and Proxy Pool
    log.info('Test 2: Setting up job queue and proxy pool...');
    
    const proxyPool = new ProxyPoolManager(redisClient, ['http://test-proxy:8080']);
    const jobQueue = new JobQueueManager(redisClient, proxyPool);
    
    log.info('✓ Job queue and proxy pool initialized');
    
    // Test 3: Enqueue Test Task
    log.info('Test 3: Enqueuing test task...');
    
    const testCredentials = [
      { username: `test-${Date.now()}@example.com`, password: 'testpass123' }
    ];
    
    const batchId = `test-batch-${Date.now()}`;
    const enqueueResult = await jobQueue.enqueueBatch(batchId, testCredentials, {
      batchType: 'TEST',
      chatId: 123456,
      messageId: 789
    });
    
    log.info('✓ Test task enqueued', { 
      batchId, 
      queued: enqueueResult.queued,
      cached: enqueueResult.cached 
    });
    
    if (enqueueResult.queued === 0) {
      log.warn('No tasks were queued (all cached), test cannot proceed');
      return;
    }
    
    // Test 4: Create Worker Node
    log.info('Test 4: Creating worker node...');
    
    worker = new WorkerNode(redisClient, {
      workerId: 'test-worker-task-processing',
      heartbeatInterval: 5000,
      queueTimeout: 5000,
      taskTimeout: 30000 // 30 seconds for test task
    });
    
    await worker.registerWorker();
    
    log.info('✓ Worker node created and registered');
    
    // Test 5: Process Single Task
    log.info('Test 5: Processing task...');
    
    // Mock the credential check to avoid actual HTTP requests
    const httpChecker = require('../httpChecker');
    const originalCheckCredentials = httpChecker.checkCredentials;
    
    // Create a mock function that returns a proper result
    const mockCheckCredentials = async (username, password, options) => {
      log.info('Mock credential check called', { username, password });
      
      // Simulate processing time
      await new Promise(resolve => setTimeout(resolve, 500));
      
      return {
        status: 'INVALID', // Use INVALID to avoid IP fetching and data capture
        message: 'Mock test result',
        session: null
      };
    };
    
    // Replace the function in the module
    httpChecker.checkCredentials = mockCheckCredentials;
    
    try {
      // Dequeue and process one task
      const task = await worker.dequeueTask();
      
      if (!task) {
        throw new Error('No task was dequeued from the queue');
      }
      
      log.info('✓ Task dequeued successfully', { 
        taskId: task.taskId,
        batchId: task.batchId,
        username: task.username
      });
      
      // Process the task
      await worker.processTaskWithLease(task);
      
      log.info('✓ Task processed successfully');
      
      // Test 6: Verify Result Storage
      log.info('Test 6: Verifying result storage...');
      
      // Check if result was stored in Redis (could be INVALID or ERROR)
      let resultKey = `result:INVALID:${task.username}:${task.password}`;
      let storedResult = await redisClient.executeCommand('get', resultKey);
      
      if (!storedResult) {
        // Try ERROR status
        resultKey = `result:ERROR:${task.username}:${task.password}`;
        storedResult = await redisClient.executeCommand('get', resultKey);
      }
      
      if (!storedResult) {
        throw new Error('Result was not stored in Redis');
      }
      
      const result = JSON.parse(storedResult);
      
      if (!['INVALID', 'ERROR'].includes(result.status)) {
        throw new Error(`Expected status INVALID or ERROR, got ${result.status}`);
      }
      
      if (result.workerId !== worker.workerId) {
        throw new Error(`Expected workerId ${worker.workerId}, got ${result.workerId}`);
      }
      
      log.info('✓ Result stored correctly in Redis', {
        status: result.status,
        workerId: result.workerId,
        checkDurationMs: result.checkDurationMs,
        resultKey
      });
      
      // Test 7: Verify Progress Tracking
      log.info('Test 7: Verifying progress tracking...');
      
      const progressKey = `progress:${batchId}:count`;
      const progressCount = await redisClient.executeCommand('get', progressKey);
      
      if (!progressCount || parseInt(progressCount) !== 1) {
        throw new Error(`Expected progress count 1, got ${progressCount}`);
      }
      
      log.info('✓ Progress tracking working correctly', { progressCount });
      
    } finally {
      // Restore original function
      httpChecker.checkCredentials = originalCheckCredentials;
    }
    
    // Test 8: Cleanup
    log.info('Test 8: Cleaning up...');
    
    await worker.cleanup();
    
    // Clean up test data
    await redisClient.executeCommand('del', `result:INVALID:${testCredentials[0].username}:${testCredentials[0].password}`);
    await redisClient.executeCommand('del', `result:ERROR:${testCredentials[0].username}:${testCredentials[0].password}`);
    await redisClient.executeCommand('del', `progress:${batchId}:count`);
    await redisClient.executeCommand('del', `progress:${batchId}`);
    
    log.info('✓ Cleanup completed');
    
    log.info('🎉 All worker task processing tests passed!');
    
  } catch (error) {
    log.error('❌ Worker task processing test failed', {
      error: error.message,
      stack: error.stack
    });
    throw error;
    
  } finally {
    if (worker) {
      await worker.cleanup();
    }
    if (redisClient) {
      await redisClient.close();
    }
  }
}

// Run the test
if (require.main === module) {
  testWorkerTaskProcessing()
    .then(() => {
      log.info('Worker task processing test completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      log.error('Fatal error in task processing test', {
        error: error.message,
        stack: error.stack
      });
      process.exit(1);
    });
}

module.exports = { testWorkerTaskProcessing };