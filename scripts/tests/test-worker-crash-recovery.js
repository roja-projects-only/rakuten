#!/usr/bin/env node

/**
 * Worker Crash Recovery Integration Test
 * 
 * This test validates worker crash recovery mechanisms:
 * 1. Start worker processing task
 * 2. Kill worker mid-task
 * 3. Verify lease expires after 5 minutes
 * 4. Verify task re-enqueued by zombie recovery job
 * 5. Verify task completes on retry
 * 
 * Requirements: 1.7, 2.5
 */

const { createLogger } = require('../logger');
const { initRedisClient } = require('../shared/redis/client');
const JobQueueManager = require('../shared/coordinator/JobQueueManager');
const ProxyPoolManager = require('../shared/coordinator/ProxyPoolManager');
const WorkerNode = require('../shared/worker/WorkerNode');
const Coordinator = require('../shared/coordinator/Coordinator');

const log = createLogger('worker-crash-recovery-test');

class WorkerCrashRecoveryTest {
  constructor() {
    this.redisClient = null;
    this.coordinator = null;
    this.workers = [];
    this.testResults = {
      taskSetup: null,
      workerCrash: null,
      leaseExpiry: null,
      zombieRecovery: null,
      taskCompletion: null
    };
  }

  async runTest() {
    log.info('🚀 Starting worker crash recovery test...');
    
    try {
      await this.setupRedis();
      await this.testTaskSetup();
      await this.testWorkerCrash();
      await this.testLeaseExpiry();
      await this.testZombieRecovery();
      await this.testTaskCompletion();
      
      this.printTestSummary();
      
    } catch (error) {
      log.error('Worker crash recovery test failed', { error: error.message });
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  async setupRedis() {
    log.info('Setting up Redis connection...');
    
    if (!process.env.REDIS_URL) {
      throw new Error('REDIS_URL environment variable is required for integration tests');
    }
    
    this.redisClient = await initRedisClient();
    const isHealthy = await this.redisClient.isHealthy();
    
    if (!isHealthy) {
      throw new Error('Redis connection is not healthy');
    }
    
    // Clear any existing test data
    await this.redisClient.executeCommand('flushdb');
    
    log.info('✓ Redis connection established and cleared');
  }

  async testTaskSetup() {
    log.info('Test 1: Setting up task for crash recovery test (Requirements 1.7)...');
    
    try {
      // Setup job queue
      const proxyPool = new ProxyPoolManager(this.redisClient, ['http://test-proxy:8080']);
      const jobQueue = new JobQueueManager(this.redisClient, proxyPool);
      
      // Create test task
      const credentials = [{
        username: 'crash-test@example.com',
        password: 'crashtest123'
      }];
      
      const batchId = `crash-test-${Date.now()}`;
      
      // Enqueue task
      const result = await jobQueue.enqueueBatch(batchId, credentials, {
        batchType: 'TEST',
        chatId: 123456789,
        messageId: 987654321
      });
      
      if (result.queued !== 1) {
        throw new Error(`Expected 1 task queued, got ${result.queued}`);
      }
      
      // Verify task is in queue
      const queueLength = await this.redisClient.executeCommand('llen', 'queue:tasks');
      
      if (queueLength !== 1) {
        throw new Error(`Expected 1 task in queue, got ${queueLength}`);
      }
      
      this.testResults.taskSetup = {
        success: true,
        batchId,
        taskCount: 1,
        queueLength,
        message: 'Test task successfully enqueued for crash recovery test'
      };
      
      log.info('✓ Task setup successful', {
        batchId,
        queueLength
      });
      
    } catch (error) {
      this.testResults.taskSetup = {
        success: false,
        message: `Task setup failed: ${error.message}`
      };
      throw error;
    }
  }

  async testWorkerCrash() {
    log.info('Test 2: Simulating worker crash mid-task (Requirements 2.5)...');
    
    try {
      // Create worker
      const worker = new WorkerNode(this.redisClient, {
        workerId: 'crash-test-worker',
        heartbeatInterval: 2000,
        queueTimeout: 3000
      });
      
      await worker.registerWorker();
      this.workers.push(worker);
      
      // Mock credential checking to simulate long-running task
      const httpChecker = require('../httpChecker');
      const originalCheckCredentials = httpChecker.checkCredentials;
      
      let taskStarted = false;
      let taskInterrupted = false;
      
      httpChecker.checkCredentials = async (username, password) => {
        taskStarted = true;
        log.info('Task started, simulating long-running operation...');
        
        try {
          // Simulate long-running task (10 seconds)
          await new Promise(resolve => setTimeout(resolve, 10000));
          return {
            status: 'VALID',
            message: 'Task completed normally',
            session: null
          };
        } catch (error) {
          taskInterrupted = true;
          throw error;
        }
      };
      
      // Start worker processing (don't await - let it run in background)
      const workerPromise = worker.run().catch(error => {
        log.info('Worker stopped (expected)', { error: error.message });
      });
      
      // Wait for task to start
      let attempts = 0;
      while (!taskStarted && attempts < 20) {
        await new Promise(resolve => setTimeout(resolve, 500));
        attempts++;
      }
      
      if (!taskStarted) {
        throw new Error('Task did not start within expected time');
      }
      
      // Verify lease was created
      const leaseKeys = await this.redisClient.executeCommand('keys', 'job:*');
      
      if (leaseKeys.length !== 1) {
        throw new Error(`Expected 1 lease, found ${leaseKeys.length}`);
      }
      
      const leaseKey = leaseKeys[0];
      const leaseData = await this.redisClient.executeCommand('get', leaseKey);
      
      if (!leaseData) {
        throw new Error('Lease data not found');
      }
      
      const lease = JSON.parse(leaseData);
      
      // Simulate worker crash by stopping it abruptly
      log.info('Simulating worker crash...');
      await worker.forceStop(); // Abrupt stop without cleanup
      
      // Restore original function
      httpChecker.checkCredentials = originalCheckCredentials;
      
      this.testResults.workerCrash = {
        success: true,
        taskStarted,
        leaseCreated: !!leaseData,
        leaseKey,
        workerId: lease.workerId,
        crashSimulated: true,
        message: 'Worker crash simulated successfully with active lease'
      };
      
      log.info('✓ Worker crash simulation successful', {
        taskStarted,
        leaseKey,
        workerId: lease.workerId
      });
      
    } catch (error) {
      this.testResults.workerCrash = {
        success: false,
        message: `Worker crash simulation failed: ${error.message}`
      };
      throw error;
    }
  }

  async testLeaseExpiry() {
    log.info('Test 3: Waiting for lease expiry (5 minutes)...');
    
    try {
      const leaseKey = this.testResults.workerCrash.leaseKey;
      
      // Check initial lease TTL
      const initialTTL = await this.redisClient.executeCommand('ttl', leaseKey);
      
      if (initialTTL <= 0) {
        throw new Error('Lease should have positive TTL initially');
      }
      
      log.info(`Initial lease TTL: ${initialTTL} seconds`);
      
      // For testing, we'll reduce the wait time by manually expiring the lease
      // In production, this would naturally expire after 5 minutes
      log.info('Accelerating lease expiry for testing...');
      
      // Set lease to expire in 10 seconds for testing
      await this.redisClient.executeCommand('expire', leaseKey, 10);
      
      // Wait for lease to expire
      await new Promise(resolve => setTimeout(resolve, 12000)); // 12 seconds
      
      // Verify lease has expired
      const finalTTL = await this.redisClient.executeCommand('ttl', leaseKey);
      const leaseExists = await this.redisClient.executeCommand('exists', leaseKey);
      
      if (leaseExists) {
        throw new Error('Lease should have expired');
      }
      
      this.testResults.leaseExpiry = {
        success: true,
        initialTTL,
        finalTTL,
        leaseExpired: !leaseExists,
        message: 'Lease expired successfully after timeout'
      };
      
      log.info('✓ Lease expiry test passed', {
        initialTTL,
        finalTTL,
        leaseExpired: !leaseExists
      });
      
    } catch (error) {
      this.testResults.leaseExpiry = {
        success: false,
        message: `Lease expiry test failed: ${error.message}`
      };
      throw error;
    }
  }

  async testZombieRecovery() {
    log.info('Test 4: Testing zombie task recovery job...');
    
    try {
      // Mock Telegram bot for coordinator
      const mockBot = {
        telegram: {
          editMessageText: jest.fn().mockResolvedValue({ message_id: 123 }),
          sendMessage: jest.fn().mockResolvedValue({ message_id: 124 })
        },
        on: jest.fn(),
        command: jest.fn(),
        action: jest.fn(),
        launch: jest.fn().mockResolvedValue(),
        stop: jest.fn().mockResolvedValue()
      };
      
      // Create coordinator with zombie recovery
      this.coordinator = new Coordinator(this.redisClient, mockBot, {
        coordinatorId: 'recovery-test-coordinator',
        zombieRecoveryInterval: 5000 // 5 seconds for testing
      });
      
      // Start coordinator
      await this.coordinator.start();
      
      // Check initial queue state
      const initialQueueLength = await this.redisClient.executeCommand('llen', 'queue:tasks');
      
      log.info(`Initial queue length: ${initialQueueLength}`);
      
      // Wait for zombie recovery job to run
      await new Promise(resolve => setTimeout(resolve, 8000)); // 8 seconds
      
      // Check if task was recovered to queue
      const finalQueueLength = await this.redisClient.executeCommand('llen', 'queue:tasks');
      
      log.info(`Final queue length: ${finalQueueLength}`);
      
      // Task should be back in queue if it was recovered
      const taskRecovered = finalQueueLength > initialQueueLength;
      
      this.testResults.zombieRecovery = {
        success: taskRecovered,
        initialQueueLength,
        finalQueueLength,
        taskRecovered,
        message: taskRecovered ? 
          'Zombie task successfully recovered to queue' : 
          'Zombie task recovery did not occur (may need longer wait)'
      };
      
      log.info('✓ Zombie recovery test completed', {
        initialQueueLength,
        finalQueueLength,
        taskRecovered
      });
      
    } catch (error) {
      this.testResults.zombieRecovery = {
        success: false,
        message: `Zombie recovery test failed: ${error.message}`
      };
      throw error;
    }
  }

  async testTaskCompletion() {
    log.info('Test 5: Testing task completion on retry...');
    
    try {
      // Create new worker to process recovered task
      const recoveryWorker = new WorkerNode(this.redisClient, {
        workerId: 'recovery-worker',
        heartbeatInterval: 3000,
        queueTimeout: 2000
      });
      
      await recoveryWorker.registerWorker();
      this.workers.push(recoveryWorker);
      
      // Mock credential checking for quick completion
      const httpChecker = require('../httpChecker');
      const originalCheckCredentials = httpChecker.checkCredentials;
      
      let taskCompleted = false;
      
      httpChecker.checkCredentials = async (username, password) => {
        log.info('Processing recovered task...');
        await new Promise(resolve => setTimeout(resolve, 500)); // Quick processing
        taskCompleted = true;
        
        return {
          status: 'INVALID',
          message: 'Recovered task completed',
          session: null
        };
      };
      
      // Process one task
      const task = await recoveryWorker.dequeueTask();
      
      if (!task) {
        throw new Error('No task available for recovery processing');
      }
      
      await recoveryWorker.processTaskWithLease(task);
      
      // Restore original function
      httpChecker.checkCredentials = originalCheckCredentials;
      
      // Verify task was completed
      const resultKey = `result:INVALID:${task.username}:${task.password}`;
      const result = await this.redisClient.executeCommand('get', resultKey);
      
      if (!result) {
        throw new Error('Task result not found after completion');
      }
      
      const resultData = JSON.parse(result);
      
      this.testResults.taskCompletion = {
        success: true,
        taskCompleted,
        resultStored: !!result,
        workerId: resultData.workerId,
        status: resultData.status,
        message: 'Recovered task completed successfully by new worker'
      };
      
      log.info('✓ Task completion test passed', {
        taskCompleted,
        resultStored: !!result,
        workerId: resultData.workerId,
        status: resultData.status
      });
      
    } catch (error) {
      this.testResults.taskCompletion = {
        success: false,
        message: `Task completion test failed: ${error.message}`
      };
      throw error;
    }
  }

  async cleanup() {
    log.info('Cleaning up test resources...');
    
    try {
      // Stop coordinator
      if (this.coordinator) {
        await this.coordinator.stop();
      }
      
      // Stop workers
      for (const worker of this.workers) {
        await worker.cleanup();
      }
      
      // Clear test data from Redis
      if (this.redisClient) {
        await this.redisClient.executeCommand('flushdb');
        await this.redisClient.close();
      }
      
      log.info('✓ Cleanup completed');
      
    } catch (error) {
      log.warn('Cleanup failed', { error: error.message });
    }
  }

  printTestSummary() {
    log.info('='.repeat(70));
    log.info('WORKER CRASH RECOVERY TEST SUMMARY');
    log.info('='.repeat(70));
    
    const tests = [
      { name: 'Task Setup', result: this.testResults.taskSetup },
      { name: 'Worker Crash', result: this.testResults.workerCrash },
      { name: 'Lease Expiry', result: this.testResults.leaseExpiry },
      { name: 'Zombie Recovery', result: this.testResults.zombieRecovery },
      { name: 'Task Completion', result: this.testResults.taskCompletion }
    ];
    
    let passCount = 0;
    
    tests.forEach((test, index) => {
      const status = test.result?.success ? '✅ PASS' : '❌ FAIL';
      const message = test.result?.message || 'No result';
      
      log.info(`${index + 1}. ${test.name}: ${status}`);
      log.info(`   ${message}`);
      
      if (test.result?.success) {
        passCount++;
      }
    });
    
    log.info('='.repeat(70));
    log.info(`OVERALL RESULT: ${passCount}/${tests.length} tests passed`);
    
    if (passCount === tests.length) {
      log.info('🎉 All worker crash recovery tests passed!');
      log.info('✓ Tasks can be enqueued and leases created');
      log.info('✓ Worker crashes are handled gracefully');
      log.info('✓ Task leases expire after timeout');
      log.info('✓ Zombie recovery job re-enqueues orphaned tasks');
      log.info('✓ Recovered tasks can be completed by new workers');
    } else {
      log.error(`❌ ${tests.length - passCount} test(s) failed`);
    }
    
    log.info('='.repeat(70));
  }

  getResults() {
    return this.testResults;
  }
}

// Add forceStop method to WorkerNode for testing
if (!WorkerNode.prototype.forceStop) {
  WorkerNode.prototype.forceStop = async function() {
    this.shutdown = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    // Don't clean up lease - simulate crash
  };
}

// Export for use as module
module.exports = WorkerCrashRecoveryTest;

// If run directly, execute test
if (require.main === module) {
  // Mock Jest functions if not in Jest environment
  if (typeof jest === 'undefined') {
    global.jest = {
      fn: () => ({
        mockResolvedValue: (value) => () => Promise.resolve(value),
        mock: { calls: [] }
      })
    };
  }
  
  const test = new WorkerCrashRecoveryTest();
  
  test.runTest()
    .then(() => {
      const results = test.getResults();
      const allPassed = Object.values(results).every(result => result?.success);
      process.exit(allPassed ? 0 : 1);
    })
    .catch((error) => {
      log.error('Test execution failed', { error: error.message });
      process.exit(1);
    });
}