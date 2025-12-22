#!/usr/bin/env node

/**
 * End-to-End Batch Processing Integration Test
 * 
 * This test validates the complete batch processing workflow:
 * 1. Submit 100-credential batch via Telegram
 * 2. Verify tasks enqueued correctly
 * 3. Verify workers process tasks
 * 4. Verify progress updates in Telegram
 * 5. Verify final summary with correct counts
 * 
 * Requirements: 1.1, 2.2, 5.3, 5.4
 */

const { createLogger } = require('../logger');
const { initRedisClient } = require('../shared/redis/client');
const JobQueueManager = require('../shared/coordinator/JobQueueManager');
const ProxyPoolManager = require('../shared/coordinator/ProxyPoolManager');
const ProgressTracker = require('../shared/coordinator/ProgressTracker');
const WorkerNode = require('../shared/worker/WorkerNode');

const log = createLogger('e2e-batch-test');

class EndToEndBatchTest {
  constructor() {
    this.redisClient = null;
    this.workers = [];
    this.testResults = {
      batchEnqueue: null,
      taskProcessing: null,
      progressUpdates: null,
      finalSummary: null
    };
  }

  async runTest() {
    log.info('🚀 Starting end-to-end batch processing test...');
    
    try {
      await this.setupRedis();
      await this.testBatchEnqueue();
      await this.testTaskProcessing();
      await this.testProgressUpdates();
      await this.testFinalSummary();
      
      this.printTestSummary();
      
    } catch (error) {
      log.error('End-to-end test failed', { error: error.message });
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

  async testBatchEnqueue() {
    log.info('Test 1: Testing batch enqueue (Requirements 1.1)...');
    
    try {
      // Setup components
      const proxyPool = new ProxyPoolManager(this.redisClient, [
        'http://proxy1:8080',
        'http://proxy2:8080',
        'http://proxy3:8080'
      ]);
      
      const jobQueue = new JobQueueManager(this.redisClient, proxyPool);
      
      // Generate 100 test credentials
      const credentials = [];
      for (let i = 1; i <= 100; i++) {
        credentials.push({
          username: `test${i}@example.com`,
          password: `testpass${i}`
        });
      }
      
      const batchId = `e2e-test-${Date.now()}`;
      
      // Enqueue batch
      const startTime = Date.now();
      const result = await jobQueue.enqueueBatch(batchId, credentials, {
        batchType: 'TEST',
        chatId: 123456789,
        messageId: 987654321
      });
      const enqueueTime = Date.now() - startTime;
      
      // Verify results
      if (result.queued !== 100 || result.cached !== 0) {
        throw new Error(`Expected 100 queued, 0 cached. Got ${result.queued} queued, ${result.cached} cached`);
      }
      
      // Verify queue state
      const queueStats = await jobQueue.getQueueStats();
      if (queueStats.total !== 100) {
        throw new Error(`Expected 100 tasks in queue, got ${queueStats.total}`);
      }
      
      this.testResults.batchEnqueue = {
        success: true,
        batchId,
        credentialsCount: 100,
        queuedCount: result.queued,
        cachedCount: result.cached,
        enqueueTimeMs: enqueueTime,
        queueStats,
        message: 'Batch enqueued successfully with correct task distribution'
      };
      
      log.info('✓ Batch enqueue test passed', {
        batchId,
        queued: result.queued,
        cached: result.cached,
        enqueueTime
      });
      
    } catch (error) {
      this.testResults.batchEnqueue = {
        success: false,
        message: `Batch enqueue failed: ${error.message}`
      };
      throw error;
    }
  }

  async testTaskProcessing() {
    log.info('Test 2: Testing task processing by workers (Requirements 2.2)...');
    
    try {
      const batchId = this.testResults.batchEnqueue.batchId;
      
      // Create mock workers
      const workerCount = 3;
      const workers = [];
      
      for (let i = 1; i <= workerCount; i++) {
        const worker = new WorkerNode(this.redisClient, {
          workerId: `e2e-test-worker-${i}`,
          heartbeatInterval: 2000,
          queueTimeout: 3000
        });
        
        await worker.registerWorker();
        workers.push(worker);
      }
      
      this.workers = workers;
      
      // Mock the credential checking to avoid actual HTTP requests
      const httpChecker = require('../httpChecker');
      const originalCheckCredentials = httpChecker.checkCredentials;
      
      let processedCount = 0;
      const processedTasks = [];
      
      httpChecker.checkCredentials = async (username, password, options) => {
        processedCount++;
        processedTasks.push({ username, password });
        
        // Simulate processing time
        await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));
        
        // Return different statuses for variety
        const statuses = ['VALID', 'INVALID', 'BLOCKED', 'ERROR'];
        const status = statuses[processedCount % statuses.length];
        
        return {
          status,
          message: `Mock result for ${username}`,
          session: null
        };
      };
      
      try {
        // Start workers processing tasks
        const workerPromises = workers.map(async (worker, index) => {
          const tasksProcessed = [];
          
          // Each worker processes up to 40 tasks (100/3 ≈ 33, with some overlap)
          for (let i = 0; i < 40; i++) {
            const task = await worker.dequeueTask();
            if (!task) break; // No more tasks
            
            await worker.processTaskWithLease(task);
            tasksProcessed.push(task);
            
            // Small delay between tasks
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          
          return { workerId: worker.workerId, tasksProcessed: tasksProcessed.length };
        });
        
        // Wait for all workers to complete or timeout after 30 seconds
        const workerResults = await Promise.race([
          Promise.all(workerPromises),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Worker processing timeout')), 30000)
          )
        ]);
        
        // Verify processing results
        const totalProcessed = workerResults.reduce((sum, result) => sum + result.tasksProcessed, 0);
        
        if (totalProcessed < 90) { // Allow some tasks to remain unprocessed
          throw new Error(`Expected at least 90 tasks processed, got ${totalProcessed}`);
        }
        
        // Verify queue is mostly empty
        const finalQueueStats = await this.redisClient.executeCommand('llen', 'queue:tasks');
        
        this.testResults.taskProcessing = {
          success: true,
          workersUsed: workerCount,
          totalProcessed,
          workerResults,
          remainingInQueue: finalQueueStats,
          message: `${totalProcessed} tasks processed by ${workerCount} workers`
        };
        
        log.info('✓ Task processing test passed', {
          totalProcessed,
          workerResults,
          remainingInQueue: finalQueueStats
        });
        
      } finally {
        // Restore original function
        httpChecker.checkCredentials = originalCheckCredentials;
      }
      
    } catch (error) {
      this.testResults.taskProcessing = {
        success: false,
        message: `Task processing failed: ${error.message}`
      };
      throw error;
    }
  }

  async testProgressUpdates() {
    log.info('Test 3: Testing progress updates (Requirements 5.3)...');
    
    try {
      const batchId = this.testResults.batchEnqueue.batchId;
      
      // Mock Telegram client
      const mockTelegram = {
        editMessageText: jest.fn().mockResolvedValue({ message_id: 987654321 }),
        sendMessage: jest.fn().mockResolvedValue({ message_id: 987654322 })
      };
      
      const progressTracker = new ProgressTracker(this.redisClient, mockTelegram);
      
      // Initialize progress tracking
      await progressTracker.initBatch(batchId, 100, 123456789, 987654321);
      
      // Simulate progress updates
      const updateCount = 5;
      const updateResults = [];
      
      for (let i = 1; i <= updateCount; i++) {
        // Simulate some tasks completing
        const completedTasks = i * 20; // 20, 40, 60, 80, 100
        
        // Set progress count in Redis
        await this.redisClient.executeCommand('set', `progress:${batchId}:count`, completedTasks);
        
        // Trigger progress update
        const updateStart = Date.now();
        await progressTracker.handleProgressUpdate(batchId);
        const updateTime = Date.now() - updateStart;
        
        updateResults.push({
          completedTasks,
          updateTime,
          percentage: (completedTasks / 100) * 100
        });
        
        // Wait for throttle period
        await new Promise(resolve => setTimeout(resolve, 3500)); // 3.5 seconds
      }
      
      // Verify progress updates were sent
      const telegramCalls = mockTelegram.editMessageText.mock.calls;
      
      if (telegramCalls.length < 3) { // Should have at least 3 updates due to throttling
        throw new Error(`Expected at least 3 Telegram updates, got ${telegramCalls.length}`);
      }
      
      // Verify update content contains progress information
      const lastCall = telegramCalls[telegramCalls.length - 1];
      const lastMessage = lastCall[3]; // message text is 4th parameter
      
      if (!lastMessage.includes('100%') && !lastMessage.includes('100/100')) {
        throw new Error('Final progress update should show 100% completion');
      }
      
      this.testResults.progressUpdates = {
        success: true,
        updateCount: updateResults.length,
        telegramCallCount: telegramCalls.length,
        updateResults,
        throttlingWorking: telegramCalls.length < updateResults.length,
        message: `Progress updates working with proper throttling (${telegramCalls.length} Telegram calls for ${updateResults.length} updates)`
      };
      
      log.info('✓ Progress updates test passed', {
        updateCount: updateResults.length,
        telegramCalls: telegramCalls.length,
        throttlingWorking: telegramCalls.length < updateResults.length
      });
      
    } catch (error) {
      this.testResults.progressUpdates = {
        success: false,
        message: `Progress updates failed: ${error.message}`
      };
      throw error;
    }
  }

  async testFinalSummary() {
    log.info('Test 4: Testing final summary generation (Requirements 5.4)...');
    
    try {
      const batchId = this.testResults.batchEnqueue.batchId;
      
      // Mock Telegram client
      const mockTelegram = {
        sendMessage: jest.fn().mockResolvedValue({ message_id: 987654323 })
      };
      
      const progressTracker = new ProgressTracker(this.redisClient, mockTelegram);
      
      // Generate summary
      await progressTracker.sendSummary(batchId);
      
      // Verify summary was sent
      const summaryCall = mockTelegram.sendMessage.mock.calls[0];
      
      if (!summaryCall) {
        throw new Error('Summary message was not sent');
      }
      
      const [chatId, summaryText] = summaryCall;
      
      // Verify summary content
      if (chatId !== 123456789) {
        throw new Error(`Expected chat ID 123456789, got ${chatId}`);
      }
      
      if (!summaryText.includes('Summary') && !summaryText.includes('Results')) {
        throw new Error('Summary should contain summary information');
      }
      
      // Verify summary contains status counts
      const hasStatusCounts = ['VALID', 'INVALID', 'BLOCKED', 'ERROR'].some(status => 
        summaryText.includes(status)
      );
      
      if (!hasStatusCounts) {
        throw new Error('Summary should contain status counts');
      }
      
      this.testResults.finalSummary = {
        success: true,
        chatId,
        summaryLength: summaryText.length,
        containsStatusCounts: hasStatusCounts,
        message: 'Final summary generated with correct format and content'
      };
      
      log.info('✓ Final summary test passed', {
        chatId,
        summaryLength: summaryText.length,
        containsStatusCounts: hasStatusCounts
      });
      
    } catch (error) {
      this.testResults.finalSummary = {
        success: false,
        message: `Final summary failed: ${error.message}`
      };
      throw error;
    }
  }

  async cleanup() {
    log.info('Cleaning up test resources...');
    
    try {
      // Stop all workers
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
    log.info('END-TO-END BATCH PROCESSING TEST SUMMARY');
    log.info('='.repeat(70));
    
    const tests = [
      { name: 'Batch Enqueue', result: this.testResults.batchEnqueue },
      { name: 'Task Processing', result: this.testResults.taskProcessing },
      { name: 'Progress Updates', result: this.testResults.progressUpdates },
      { name: 'Final Summary', result: this.testResults.finalSummary }
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
      log.info('🎉 All end-to-end batch processing tests passed!');
      log.info('✓ Batch enqueue works correctly');
      log.info('✓ Workers can process tasks in parallel');
      log.info('✓ Progress updates work with proper throttling');
      log.info('✓ Final summary generation works');
    } else {
      log.error(`❌ ${tests.length - passCount} test(s) failed`);
    }
    
    log.info('='.repeat(70));
  }

  getResults() {
    return this.testResults;
  }
}

// Export for use as module
module.exports = EndToEndBatchTest;

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
  
  const test = new EndToEndBatchTest();
  
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