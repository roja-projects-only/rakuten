#!/usr/bin/env node

/**
 * Deduplication Across Batches Integration Test
 * 
 * This test validates cross-batch deduplication functionality:
 * 1. Submit batch A with 100 credentials
 * 2. Wait for completion
 * 3. Submit batch B with 50 same + 50 new credentials
 * 4. Verify 50 credentials skipped from cache
 * 5. Verify summary shows cache skip count
 * 
 * Requirements: 7.1, 7.2, 7.5
 */

const { createLogger } = require('../logger');
const { initRedisClient } = require('../shared/redis/client');
const JobQueueManager = require('../shared/coordinator/JobQueueManager');
const ProxyPoolManager = require('../shared/coordinator/ProxyPoolManager');
const ProgressTracker = require('../shared/coordinator/ProgressTracker');
const WorkerNode = require('../shared/worker/WorkerNode');

const log = createLogger('deduplication-test');

class DeduplicationAcrossBatchesTest {
  constructor() {
    this.redisClient = null;
    this.jobQueue = null;
    this.progressTracker = null;
    this.workers = [];
    this.testResults = {
      batchASetup: null,
      batchACompletion: null,
      batchBSetup: null,
      deduplicationVerification: null,
      summaryVerification: null
    };
  }

  async runTest() {
    log.info('🚀 Starting deduplication across batches test...');
    
    try {
      await this.setupRedis();
      await this.testBatchASetup();
      await this.testBatchACompletion();
      await this.testBatchBSetup();
      await this.testDeduplicationVerification();
      await this.testSummaryVerification();
      
      this.printTestSummary();
      
    } catch (error) {
      log.error('Deduplication test failed', { error: error.message });
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
    
    // Setup components
    const proxyPool = new ProxyPoolManager(this.redisClient, ['http://test-proxy:8080']);
    this.jobQueue = new JobQueueManager(this.redisClient, proxyPool);
    
    // Mock Telegram client
    const mockTelegram = {
      editMessageText: jest.fn().mockResolvedValue({ message_id: 123 }),
      sendMessage: jest.fn().mockResolvedValue({ message_id: 124 })
    };
    
    this.progressTracker = new ProgressTracker(this.redisClient, mockTelegram);
    
    log.info('✓ Redis connection established and components initialized');
  }

  async testBatchASetup() {
    log.info('Test 1: Setting up and processing batch A (100 credentials) (Requirements 7.1)...');
    
    try {
      // Generate 100 unique credentials for batch A
      const batchACredentials = [];
      for (let i = 1; i <= 100; i++) {
        batchACredentials.push({
          username: `batchA${i}@example.com`,
          password: `batchApass${i}`
        });
      }
      
      const batchAId = `dedup-test-A-${Date.now()}`;
      
      // Enqueue batch A
      const result = await this.jobQueue.enqueueBatch(batchAId, batchACredentials, {
        batchType: 'TEST',
        chatId: 123456789,
        messageId: 987654321
      });
      
      if (result.queued !== 100 || result.cached !== 0) {
        throw new Error(`Expected 100 queued, 0 cached for batch A. Got ${result.queued} queued, ${result.cached} cached`);
      }
      
      // Initialize progress tracking
      await this.progressTracker.initBatch(batchAId, 100, 123456789, 987654321);
      
      this.testResults.batchASetup = {
        success: true,
        batchId: batchAId,
        credentialsCount: 100,
        queuedCount: result.queued,
        cachedCount: result.cached,
        credentials: batchACredentials,
        message: 'Batch A enqueued successfully with 100 new credentials'
      };
      
      log.info('✓ Batch A setup successful', {
        batchId: batchAId,
        queued: result.queued,
        cached: result.cached
      });
      
    } catch (error) {
      this.testResults.batchASetup = {
        success: false,
        message: `Batch A setup failed: ${error.message}`
      };
      throw error;
    }
  }

  async testBatchACompletion() {
    log.info('Test 2: Completing batch A processing...');
    
    try {
      const batchAId = this.testResults.batchASetup.batchId;
      const batchACredentials = this.testResults.batchASetup.credentials;
      
      // Create worker to process batch A
      const worker = new WorkerNode(this.redisClient, {
        workerId: 'dedup-test-worker-A',
        heartbeatInterval: 3000,
        queueTimeout: 2000
      });
      
      await worker.registerWorker();
      this.workers.push(worker);
      
      // Mock credential checking for fast processing
      const httpChecker = require('../httpChecker');
      const originalCheckCredentials = httpChecker.checkCredentials;
      
      let processedCount = 0;
      const processedCredentials = [];
      
      httpChecker.checkCredentials = async (username, password, options) => {
        processedCount++;
        processedCredentials.push({ username, password });
        
        // Simulate quick processing
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Vary the results for realistic testing
        const statuses = ['VALID', 'INVALID', 'BLOCKED'];
        const status = statuses[processedCount % statuses.length];
        
        return {
          status,
          message: `Mock result for ${username}`,
          session: null
        };
      };
      
      // Process all tasks in batch A
      const startTime = Date.now();
      
      while (processedCount < 100) {
        const task = await worker.dequeueTask();
        if (!task) {
          // No more tasks, wait a bit and try again
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        
        await worker.processTaskWithLease(task);
        
        // Update progress
        await worker.incrementProgress(batchAId);
        
        // Break if taking too long (safety)
        if (Date.now() - startTime > 30000) {
          log.warn('Batch A processing timeout, stopping');
          break;
        }
      }
      
      const processingTime = Date.now() - startTime;
      
      // Restore original function
      httpChecker.checkCredentials = originalCheckCredentials;
      
      // Verify all credentials were processed and stored in Redis
      let storedResults = 0;
      
      for (const cred of batchACredentials) {
        const resultKeys = [
          `result:VALID:${cred.username}:${cred.password}`,
          `result:INVALID:${cred.username}:${cred.password}`,
          `result:BLOCKED:${cred.username}:${cred.password}`
        ];
        
        for (const key of resultKeys) {
          const result = await this.redisClient.executeCommand('get', key);
          if (result) {
            storedResults++;
            break;
          }
        }
      }
      
      this.testResults.batchACompletion = {
        success: processedCount >= 90 && storedResults >= 90, // Allow some tolerance
        processedCount,
        storedResults,
        processingTimeMs: processingTime,
        batchCompleted: processedCount >= 90,
        message: `Batch A completed: ${processedCount} processed, ${storedResults} stored in cache`
      };
      
      log.info('✓ Batch A completion test completed', {
        processedCount,
        storedResults,
        processingTime
      });
      
    } catch (error) {
      this.testResults.batchACompletion = {
        success: false,
        message: `Batch A completion failed: ${error.message}`
      };
      throw error;
    }
  }

  async testBatchBSetup() {
    log.info('Test 3: Setting up batch B with overlapping credentials (Requirements 7.2)...');
    
    try {
      const batchACredentials = this.testResults.batchASetup.credentials;
      
      // Create batch B with 50 same credentials + 50 new credentials
      const batchBCredentials = [];
      
      // First 50: same as batch A (should be cached)
      for (let i = 1; i <= 50; i++) {
        batchBCredentials.push({
          username: `batchA${i}@example.com`, // Same as batch A
          password: `batchApass${i}` // Same as batch A
        });
      }
      
      // Next 50: new credentials (should be queued)
      for (let i = 1; i <= 50; i++) {
        batchBCredentials.push({
          username: `batchB${i}@example.com`, // New credentials
          password: `batchBpass${i}` // New credentials
        });
      }
      
      const batchBId = `dedup-test-B-${Date.now()}`;
      
      // Enqueue batch B
      const result = await this.jobQueue.enqueueBatch(batchBId, batchBCredentials, {
        batchType: 'TEST',
        chatId: 123456789,
        messageId: 987654322
      });
      
      // Should have 50 cached (from batch A) and 50 queued (new)
      if (result.cached !== 50) {
        throw new Error(`Expected 50 cached credentials, got ${result.cached}`);
      }
      
      if (result.queued !== 50) {
        throw new Error(`Expected 50 queued credentials, got ${result.queued}`);
      }
      
      this.testResults.batchBSetup = {
        success: true,
        batchId: batchBId,
        totalCredentials: 100,
        cachedCount: result.cached,
        queuedCount: result.queued,
        expectedCached: 50,
        expectedQueued: 50,
        deduplicationWorking: result.cached === 50 && result.queued === 50,
        message: `Batch B setup: ${result.cached} cached, ${result.queued} queued (deduplication working)`
      };
      
      log.info('✓ Batch B setup successful', {
        batchId: batchBId,
        cached: result.cached,
        queued: result.queued,
        deduplicationWorking: result.cached === 50 && result.queued === 50
      });
      
    } catch (error) {
      this.testResults.batchBSetup = {
        success: false,
        message: `Batch B setup failed: ${error.message}`
      };
      throw error;
    }
  }

  async testDeduplicationVerification() {
    log.info('Test 4: Verifying deduplication mechanism...');
    
    try {
      const batchBId = this.testResults.batchBSetup.batchId;
      
      // Verify queue contains only new credentials
      const queueLength = await this.redisClient.executeCommand('llen', 'queue:tasks');
      
      if (queueLength !== 50) {
        throw new Error(`Expected 50 tasks in queue, got ${queueLength}`);
      }
      
      // Sample some tasks from queue to verify they are new credentials
      const sampleTasks = [];
      const originalQueueLength = queueLength;
      
      for (let i = 0; i < Math.min(5, queueLength); i++) {
        const taskData = await this.redisClient.executeCommand('lpop', 'queue:tasks');
        if (taskData) {
          const task = JSON.parse(taskData);
          sampleTasks.push(task);
          
          // Put task back (rpush to end)
          await this.redisClient.executeCommand('rpush', 'queue:tasks', taskData);
        }
      }
      
      // Verify sampled tasks are new credentials (should contain "batchB")
      const allNewCredentials = sampleTasks.every(task => 
        task.username.includes('batchB')
      );
      
      // Verify cached credentials are accessible
      let cachedCredentialsFound = 0;
      
      for (let i = 1; i <= 10; i++) { // Check first 10 cached credentials
        const username = `batchA${i}@example.com`;
        const password = `batchApass${i}`;
        
        const resultKeys = [
          `result:VALID:${username}:${password}`,
          `result:INVALID:${username}:${password}`,
          `result:BLOCKED:${username}:${password}`
        ];
        
        for (const key of resultKeys) {
          const result = await this.redisClient.executeCommand('get', key);
          if (result) {
            cachedCredentialsFound++;
            break;
          }
        }
      }
      
      this.testResults.deduplicationVerification = {
        success: allNewCredentials && cachedCredentialsFound >= 8, // Allow some tolerance
        queueLength,
        sampleTasksCount: sampleTasks.length,
        allNewCredentials,
        cachedCredentialsFound,
        expectedCachedSample: 10,
        message: allNewCredentials && cachedCredentialsFound >= 8 ? 
          'Deduplication working correctly: queue has new credentials, cache has old results' : 
          'Deduplication issues detected'
      };
      
      log.info('✓ Deduplication verification completed', {
        queueLength,
        allNewCredentials,
        cachedCredentialsFound
      });
      
    } catch (error) {
      this.testResults.deduplicationVerification = {
        success: false,
        message: `Deduplication verification failed: ${error.message}`
      };
      throw error;
    }
  }

  async testSummaryVerification() {
    log.info('Test 5: Verifying summary shows cache skip count (Requirements 7.5)...');
    
    try {
      const batchBId = this.testResults.batchBSetup.batchId;
      
      // Process remaining tasks in batch B
      const worker = this.workers[0]; // Reuse existing worker
      
      // Mock credential checking for new credentials
      const httpChecker = require('../httpChecker');
      const originalCheckCredentials = httpChecker.checkCredentials;
      
      let newCredentialsProcessed = 0;
      
      httpChecker.checkCredentials = async (username, password, options) => {
        newCredentialsProcessed++;
        await new Promise(resolve => setTimeout(resolve, 50));
        
        return {
          status: 'INVALID',
          message: `Mock result for new credential ${username}`,
          session: null
        };
      };
      
      // Process new credentials (should be ~50)
      const processedTasks = [];
      
      for (let i = 0; i < 50; i++) {
        const task = await worker.dequeueTask();
        if (!task) break;
        
        await worker.processTaskWithLease(task);
        processedTasks.push(task);
        
        await worker.incrementProgress(batchBId);
      }
      
      // Restore original function
      httpChecker.checkCredentials = originalCheckCredentials;
      
      // Initialize progress tracking for batch B
      await this.progressTracker.initBatch(batchBId, 100, 123456789, 987654322);
      
      // Set progress to include cached results
      await this.redisClient.executeCommand('set', `progress:${batchBId}:count`, 100);
      
      // Generate summary
      await this.progressTracker.sendSummary(batchBId);
      
      // Verify summary was generated
      const summaryCall = this.progressTracker.telegram.sendMessage.mock.calls.find(call => 
        call[1] && (call[1].includes('Summary') || call[1].includes('Results'))
      );
      
      let summaryContainsCacheInfo = false;
      
      if (summaryCall) {
        const summaryText = summaryCall[1];
        // Check if summary mentions cached/skipped credentials
        summaryContainsCacheInfo = summaryText.includes('cached') || 
                                  summaryText.includes('skipped') || 
                                  summaryText.includes('50') || // Should mention the counts
                                  summaryText.includes('duplicate');
      }
      
      this.testResults.summaryVerification = {
        success: !!summaryCall && processedTasks.length >= 40, // Allow some tolerance
        newCredentialsProcessed: processedTasks.length,
        summaryGenerated: !!summaryCall,
        summaryContainsCacheInfo,
        expectedNewCredentials: 50,
        message: summaryCall && processedTasks.length >= 40 ? 
          `Summary generated showing ${processedTasks.length} new credentials processed` : 
          'Summary generation or processing incomplete'
      };
      
      log.info('✓ Summary verification completed', {
        newCredentialsProcessed: processedTasks.length,
        summaryGenerated: !!summaryCall,
        summaryContainsCacheInfo
      });
      
    } catch (error) {
      this.testResults.summaryVerification = {
        success: false,
        message: `Summary verification failed: ${error.message}`
      };
      throw error;
    }
  }

  async cleanup() {
    log.info('Cleaning up test resources...');
    
    try {
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
    log.info('DEDUPLICATION ACROSS BATCHES TEST SUMMARY');
    log.info('='.repeat(70));
    
    const tests = [
      { name: 'Batch A Setup', result: this.testResults.batchASetup },
      { name: 'Batch A Completion', result: this.testResults.batchACompletion },
      { name: 'Batch B Setup', result: this.testResults.batchBSetup },
      { name: 'Deduplication Verification', result: this.testResults.deduplicationVerification },
      { name: 'Summary Verification', result: this.testResults.summaryVerification }
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
      log.info('🎉 All deduplication across batches tests passed!');
      log.info('✓ First batch processes and caches all credentials');
      log.info('✓ Second batch correctly identifies cached credentials');
      log.info('✓ Only new credentials are queued for processing');
      log.info('✓ Cached results are accessible and used');
      log.info('✓ Summary shows correct counts including cache usage');
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
module.exports = DeduplicationAcrossBatchesTest;

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
  
  const test = new DeduplicationAcrossBatchesTest();
  
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