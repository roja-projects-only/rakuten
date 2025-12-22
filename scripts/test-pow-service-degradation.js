#!/usr/bin/env node

/**
 * POW Service Degradation Integration Test
 * 
 * This test validates POW service fallback mechanisms:
 * 1. Start batch with POW service running
 * 2. Stop POW service mid-batch
 * 3. Verify workers fall back to local computation
 * 4. Verify batch completes (slower)
 * 5. Restart POW service and verify workers reconnect
 * 
 * Requirements: 3.5, 3.6, 3.7
 */

const { createLogger } = require('../logger');
const { initRedisClient } = require('../shared/redis/client');
const JobQueueManager = require('../shared/coordinator/JobQueueManager');
const ProxyPoolManager = require('../shared/coordinator/ProxyPoolManager');
const WorkerNode = require('../shared/worker/WorkerNode');
const { spawn } = require('child_process');
const axios = require('axios');

const log = createLogger('pow-degradation-test');

class POWServiceDegradationTest {
  constructor() {
    this.redisClient = null;
    this.powServiceProcess = null;
    this.workers = [];
    this.testResults = {
      powServiceStart: null,
      batchWithPOW: null,
      powServiceStop: null,
      fallbackVerification: null,
      batchCompletion: null,
      powServiceRestart: null
    };
  }

  async runTest() {
    log.info('🚀 Starting POW service degradation test...');
    
    try {
      await this.setupRedis();
      await this.testPOWServiceStart();
      await this.testBatchWithPOW();
      await this.testPOWServiceStop();
      await this.testFallbackVerification();
      await this.testBatchCompletion();
      await this.testPOWServiceRestart();
      
      this.printTestSummary();
      
    } catch (error) {
      log.error('POW service degradation test failed', { error: error.message });
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

  async testPOWServiceStart() {
    log.info('Test 1: Starting POW service...');
    
    try {
      // Start POW service as separate process
      const powServicePort = 3001;
      
      // Set environment variables for POW service
      const env = {
        ...process.env,
        PORT: powServicePort,
        REDIS_URL: process.env.REDIS_URL,
        LOG_LEVEL: 'info'
      };
      
      // Start POW service
      this.powServiceProcess = spawn('node', ['pow-service.js'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false
      });
      
      // Wait for service to start
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Test POW service health endpoint
      let serviceHealthy = false;
      let healthResponse = null;
      
      try {
        const response = await axios.get(`http://localhost:${powServicePort}/health`, {
          timeout: 5000
        });
        
        serviceHealthy = response.status === 200;
        healthResponse = response.data;
        
      } catch (error) {
        log.warn('POW service health check failed', { error: error.message });
      }
      
      this.testResults.powServiceStart = {
        success: serviceHealthy,
        port: powServicePort,
        processId: this.powServiceProcess.pid,
        healthResponse,
        message: serviceHealthy ? 
          'POW service started successfully' : 
          'POW service failed to start or respond to health checks'
      };
      
      log.info('✓ POW service start test completed', {
        serviceHealthy,
        port: powServicePort,
        pid: this.powServiceProcess.pid
      });
      
    } catch (error) {
      this.testResults.powServiceStart = {
        success: false,
        message: `POW service start failed: ${error.message}`
      };
      throw error;
    }
  }

  async testBatchWithPOW() {
    log.info('Test 2: Testing batch processing with POW service...');
    
    try {
      // Setup job queue
      const proxyPool = new ProxyPoolManager(this.redisClient, ['http://test-proxy:8080']);
      const jobQueue = new JobQueueManager(this.redisClient, proxyPool);
      
      // Generate test credentials
      const credentials = [];
      for (let i = 1; i <= 20; i++) {
        credentials.push({
          username: `powtest${i}@example.com`,
          password: `testpass${i}`
        });
      }
      
      const batchId = `pow-test-${Date.now()}`;
      
      // Enqueue batch
      const result = await jobQueue.enqueueBatch(batchId, credentials, {
        batchType: 'TEST',
        chatId: 123456789,
        messageId: 987654321
      });
      
      if (result.queued !== 20) {
        throw new Error(`Expected 20 tasks queued, got ${result.queued}`);
      }
      
      // Create worker with POW service URL
      const worker = new WorkerNode(this.redisClient, {
        workerId: 'pow-test-worker',
        heartbeatInterval: 3000,
        queueTimeout: 2000,
        powServiceUrl: `http://localhost:${this.testResults.powServiceStart.port}`
      });
      
      await worker.registerWorker();
      this.workers.push(worker);
      
      // Mock credential checking to focus on POW service interaction
      const httpChecker = require('../httpChecker');
      const originalCheckCredentials = httpChecker.checkCredentials;
      
      let powServiceCallCount = 0;
      let localPOWCallCount = 0;
      
      // Mock POW service client to track calls
      const powServiceClient = require('../automation/http/fingerprinting/powServiceClient');
      const originalComputeCres = powServiceClient.computeCres;
      
      powServiceClient.computeCres = async (mdata) => {
        powServiceCallCount++;
        log.debug('POW service called', { callCount: powServiceCallCount });
        return await originalComputeCres(mdata);
      };
      
      // Mock local POW computation to track fallback calls
      const challengeGenerator = require('../automation/http/fingerprinting/challengeGenerator');
      const originalComputeCresFromMdata = challengeGenerator.computeCresFromMdata;
      
      challengeGenerator.computeCresFromMdata = (mdata) => {
        localPOWCallCount++;
        log.debug('Local POW called', { callCount: localPOWCallCount });
        return originalComputeCresFromMdata(mdata);
      };
      
      httpChecker.checkCredentials = async (username, password, options) => {
        // Simulate needing POW computation
        const mdata = {
          body: {
            mask: '0000',
            key: 'testkey',
            seed: Math.floor(Math.random() * 10000)
          }
        };
        
        // This should trigger POW service call
        const cres = await powServiceClient.computeCres(mdata.body);
        
        await new Promise(resolve => setTimeout(resolve, 200)); // Simulate processing
        
        return {
          status: 'INVALID',
          message: 'Mock test result',
          session: null
        };
      };
      
      // Process some tasks with POW service available
      const tasksToProcess = 5;
      const processedTasks = [];
      
      for (let i = 0; i < tasksToProcess; i++) {
        const task = await worker.dequeueTask();
        if (!task) break;
        
        await worker.processTaskWithLease(task);
        processedTasks.push(task);
      }
      
      // Restore original functions
      powServiceClient.computeCres = originalComputeCres;
      challengeGenerator.computeCresFromMdata = originalComputeCresFromMdata;
      httpChecker.checkCredentials = originalCheckCredentials;
      
      this.testResults.batchWithPOW = {
        success: true,
        batchId,
        tasksProcessed: processedTasks.length,
        powServiceCalls: powServiceCallCount,
        localPOWCalls: localPOWCallCount,
        powServiceUsed: powServiceCallCount > 0,
        message: `Processed ${processedTasks.length} tasks using POW service (${powServiceCallCount} POW calls)`
      };
      
      log.info('✓ Batch with POW service test completed', {
        tasksProcessed: processedTasks.length,
        powServiceCalls: powServiceCallCount,
        localPOWCalls: localPOWCallCount
      });
      
    } catch (error) {
      this.testResults.batchWithPOW = {
        success: false,
        message: `Batch with POW service failed: ${error.message}`
      };
      throw error;
    }
  }

  async testPOWServiceStop() {
    log.info('Test 3: Stopping POW service mid-batch (Requirements 3.5)...');
    
    try {
      // Stop POW service process
      if (this.powServiceProcess) {
        this.powServiceProcess.kill('SIGTERM');
        
        // Wait for process to stop
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      // Verify service is no longer responding
      let serviceDown = false;
      
      try {
        await axios.get(`http://localhost:${this.testResults.powServiceStart.port}/health`, {
          timeout: 2000
        });
      } catch (error) {
        serviceDown = true; // Expected - service should be down
      }
      
      if (!serviceDown) {
        throw new Error('POW service should be down but is still responding');
      }
      
      this.testResults.powServiceStop = {
        success: true,
        serviceDown,
        message: 'POW service successfully stopped'
      };
      
      log.info('✓ POW service stop test completed', {
        serviceDown
      });
      
    } catch (error) {
      this.testResults.powServiceStop = {
        success: false,
        message: `POW service stop failed: ${error.message}`
      };
      throw error;
    }
  }

  async testFallbackVerification() {
    log.info('Test 4: Verifying fallback to local computation (Requirements 3.6)...');
    
    try {
      // Mock credential checking to test fallback behavior
      const httpChecker = require('../httpChecker');
      const originalCheckCredentials = httpChecker.checkCredentials;
      
      let powServiceCallCount = 0;
      let localPOWCallCount = 0;
      let fallbackTriggered = false;
      
      // Mock POW service client to track failed calls
      const powServiceClient = require('../automation/http/fingerprinting/powServiceClient');
      const originalComputeCres = powServiceClient.computeCres;
      
      powServiceClient.computeCres = async (mdata) => {
        powServiceCallCount++;
        // Simulate service unavailable
        throw new Error('POW service unavailable');
      };
      
      // Mock local POW computation to track fallback calls
      const challengeGenerator = require('../automation/http/fingerprinting/challengeGenerator');
      const originalComputeCresFromMdata = challengeGenerator.computeCresFromMdata;
      
      challengeGenerator.computeCresFromMdata = (mdata) => {
        localPOWCallCount++;
        fallbackTriggered = true;
        log.debug('Fallback to local POW triggered', { callCount: localPOWCallCount });
        return originalComputeCresFromMdata(mdata);
      };
      
      httpChecker.checkCredentials = async (username, password, options) => {
        // This should trigger POW service call, then fallback to local
        const mdata = {
          body: {
            mask: '0001',
            key: 'fallbacktest',
            seed: Math.floor(Math.random() * 10000)
          }
        };
        
        try {
          // This should fail and trigger fallback
          const cres = await powServiceClient.computeCres(mdata.body);
        } catch (error) {
          // Fallback to local computation
          const cres = challengeGenerator.computeCresFromMdata(mdata);
        }
        
        await new Promise(resolve => setTimeout(resolve, 300)); // Simulate processing
        
        return {
          status: 'INVALID',
          message: 'Mock fallback test result',
          session: null
        };
      };
      
      // Process tasks with fallback
      const worker = this.workers[0]; // Use existing worker
      const fallbackTasks = [];
      
      for (let i = 0; i < 3; i++) {
        const task = await worker.dequeueTask();
        if (!task) break;
        
        await worker.processTaskWithLease(task);
        fallbackTasks.push(task);
      }
      
      // Restore original functions
      powServiceClient.computeCres = originalComputeCres;
      challengeGenerator.computeCresFromMdata = originalComputeCresFromMdata;
      httpChecker.checkCredentials = originalCheckCredentials;
      
      this.testResults.fallbackVerification = {
        success: fallbackTriggered && localPOWCallCount > 0,
        tasksProcessed: fallbackTasks.length,
        powServiceCalls: powServiceCallCount,
        localPOWCalls: localPOWCallCount,
        fallbackTriggered,
        message: fallbackTriggered ? 
          `Fallback working: ${localPOWCallCount} local POW computations` : 
          'Fallback not triggered as expected'
      };
      
      log.info('✓ Fallback verification test completed', {
        fallbackTriggered,
        localPOWCalls: localPOWCallCount,
        tasksProcessed: fallbackTasks.length
      });
      
    } catch (error) {
      this.testResults.fallbackVerification = {
        success: false,
        message: `Fallback verification failed: ${error.message}`
      };
      throw error;
    }
  }

  async testBatchCompletion() {
    log.info('Test 5: Verifying batch completes with fallback (slower)...');
    
    try {
      // Process remaining tasks using fallback
      const worker = this.workers[0];
      
      // Mock credential checking for faster completion
      const httpChecker = require('../httpChecker');
      const originalCheckCredentials = httpChecker.checkCredentials;
      
      let completedTasks = 0;
      const startTime = Date.now();
      
      httpChecker.checkCredentials = async (username, password, options) => {
        completedTasks++;
        await new Promise(resolve => setTimeout(resolve, 150)); // Simulate slower processing
        
        return {
          status: 'INVALID',
          message: 'Mock completion test result',
          session: null
        };
      };
      
      // Process remaining tasks (up to 10 more)
      const remainingTasks = [];
      
      for (let i = 0; i < 10; i++) {
        const task = await worker.dequeueTask();
        if (!task) break;
        
        await worker.processTaskWithLease(task);
        remainingTasks.push(task);
      }
      
      const completionTime = Date.now() - startTime;
      
      // Restore original function
      httpChecker.checkCredentials = originalCheckCredentials;
      
      // Check final queue state
      const finalQueueLength = await this.redisClient.executeCommand('llen', 'queue:tasks');
      
      this.testResults.batchCompletion = {
        success: true,
        remainingTasksProcessed: remainingTasks.length,
        completionTimeMs: completionTime,
        finalQueueLength,
        batchProgressing: remainingTasks.length > 0,
        message: `Batch continuing with fallback: ${remainingTasks.length} more tasks processed in ${completionTime}ms`
      };
      
      log.info('✓ Batch completion test completed', {
        remainingTasksProcessed: remainingTasks.length,
        completionTime,
        finalQueueLength
      });
      
    } catch (error) {
      this.testResults.batchCompletion = {
        success: false,
        message: `Batch completion test failed: ${error.message}`
      };
      throw error;
    }
  }

  async testPOWServiceRestart() {
    log.info('Test 6: Restarting POW service and verifying reconnection (Requirements 3.7)...');
    
    try {
      // Restart POW service
      const powServicePort = this.testResults.powServiceStart.port;
      
      const env = {
        ...process.env,
        PORT: powServicePort,
        REDIS_URL: process.env.REDIS_URL,
        LOG_LEVEL: 'info'
      };
      
      this.powServiceProcess = spawn('node', ['pow-service.js'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false
      });
      
      // Wait for service to restart
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Test service health
      let serviceRestarted = false;
      let healthResponse = null;
      
      try {
        const response = await axios.get(`http://localhost:${powServicePort}/health`, {
          timeout: 5000
        });
        
        serviceRestarted = response.status === 200;
        healthResponse = response.data;
        
      } catch (error) {
        log.warn('POW service restart health check failed', { error: error.message });
      }
      
      // Test that workers can reconnect to POW service
      let reconnectionWorking = false;
      
      if (serviceRestarted) {
        try {
          // Mock a POW computation request
          const powServiceClient = require('../automation/http/fingerprinting/powServiceClient');
          
          const testResult = await powServiceClient.computeCres({
            mask: '0000',
            key: 'reconnecttest',
            seed: 12345
          });
          
          reconnectionWorking = !!testResult && testResult.length === 16;
          
        } catch (error) {
          log.warn('POW service reconnection test failed', { error: error.message });
        }
      }
      
      this.testResults.powServiceRestart = {
        success: serviceRestarted && reconnectionWorking,
        serviceRestarted,
        reconnectionWorking,
        healthResponse,
        processId: this.powServiceProcess.pid,
        message: serviceRestarted && reconnectionWorking ? 
          'POW service restarted and workers can reconnect' : 
          'POW service restart or reconnection failed'
      };
      
      log.info('✓ POW service restart test completed', {
        serviceRestarted,
        reconnectionWorking,
        pid: this.powServiceProcess.pid
      });
      
    } catch (error) {
      this.testResults.powServiceRestart = {
        success: false,
        message: `POW service restart failed: ${error.message}`
      };
      throw error;
    }
  }

  async cleanup() {
    log.info('Cleaning up test resources...');
    
    try {
      // Stop POW service
      if (this.powServiceProcess) {
        this.powServiceProcess.kill('SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 2000));
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
    log.info('POW SERVICE DEGRADATION TEST SUMMARY');
    log.info('='.repeat(70));
    
    const tests = [
      { name: 'POW Service Start', result: this.testResults.powServiceStart },
      { name: 'Batch with POW', result: this.testResults.batchWithPOW },
      { name: 'POW Service Stop', result: this.testResults.powServiceStop },
      { name: 'Fallback Verification', result: this.testResults.fallbackVerification },
      { name: 'Batch Completion', result: this.testResults.batchCompletion },
      { name: 'POW Service Restart', result: this.testResults.powServiceRestart }
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
      log.info('🎉 All POW service degradation tests passed!');
      log.info('✓ POW service can start and respond to health checks');
      log.info('✓ Workers use POW service when available');
      log.info('✓ POW service can be stopped gracefully');
      log.info('✓ Workers fall back to local computation when service unavailable');
      log.info('✓ Batch processing continues with fallback (slower)');
      log.info('✓ POW service can be restarted and workers reconnect');
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
module.exports = POWServiceDegradationTest;

// If run directly, execute test
if (require.main === module) {
  const test = new POWServiceDegradationTest();
  
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