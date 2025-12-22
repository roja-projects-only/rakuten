#!/usr/bin/env node

/**
 * Proxy Rotation and Health Tracking Integration Test
 * 
 * This test validates proxy management functionality:
 * 1. Submit batch with multiple proxies
 * 2. Verify round-robin assignment
 * 3. Simulate proxy failures
 * 4. Verify unhealthy proxies excluded
 * 5. Verify successful proxies restored
 * 
 * Requirements: 4.2, 4.4, 4.5
 */

const { createLogger } = require('../logger');
const { initRedisClient } = require('../shared/redis/client');
const JobQueueManager = require('../shared/coordinator/JobQueueManager');
const ProxyPoolManager = require('../shared/coordinator/ProxyPoolManager');
const WorkerNode = require('../shared/worker/WorkerNode');

const log = createLogger('proxy-rotation-health-test');

class ProxyRotationHealthTest {
  constructor() {
    this.redisClient = null;
    this.proxyPool = null;
    this.jobQueue = null;
    this.workers = [];
    this.testResults = {
      proxySetup: null,
      roundRobinAssignment: null,
      proxyFailures: null,
      unhealthyExclusion: null,
      proxyRecovery: null
    };
  }

  async runTest() {
    log.info('🚀 Starting proxy rotation and health tracking test...');
    
    try {
      await this.setupRedis();
      await this.testProxySetup();
      await this.testRoundRobinAssignment();
      await this.testProxyFailures();
      await this.testUnhealthyExclusion();
      await this.testProxyRecovery();
      
      this.printTestSummary();
      
    } catch (error) {
      log.error('Proxy rotation and health test failed', { error: error.message });
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

  async testProxySetup() {
    log.info('Test 1: Setting up proxy pool (Requirements 4.2)...');
    
    try {
      // Create proxy pool with multiple proxies
      const proxies = [
        'http://proxy1.test:8080',
        'http://proxy2.test:8080',
        'http://proxy3.test:8080',
        'http://proxy4.test:8080',
        'http://proxy5.test:8080'
      ];
      
      this.proxyPool = new ProxyPoolManager(this.redisClient, proxies);
      this.jobQueue = new JobQueueManager(this.redisClient, this.proxyPool);
      
      // Verify proxy pool initialization
      const proxyStats = await this.proxyPool.getProxyStats();
      
      if (proxyStats.length !== proxies.length) {
        throw new Error(`Expected ${proxies.length} proxies, got ${proxyStats.length}`);
      }
      
      // Verify all proxies are initially healthy
      const allHealthy = proxyStats.every(proxy => proxy.healthy);
      
      if (!allHealthy) {
        throw new Error('All proxies should be healthy initially');
      }
      
      this.testResults.proxySetup = {
        success: true,
        proxyCount: proxies.length,
        allInitiallyHealthy: allHealthy,
        proxyStats,
        message: `Proxy pool initialized with ${proxies.length} healthy proxies`
      };
      
      log.info('✓ Proxy setup successful', {
        proxyCount: proxies.length,
        allHealthy
      });
      
    } catch (error) {
      this.testResults.proxySetup = {
        success: false,
        message: `Proxy setup failed: ${error.message}`
      };
      throw error;
    }
  }

  async testRoundRobinAssignment() {
    log.info('Test 2: Testing round-robin proxy assignment...');
    
    try {
      // Generate test credentials for round-robin testing
      const credentials = [];
      for (let i = 1; i <= 25; i++) { // 5 proxies × 5 tasks each
        credentials.push({
          username: `roundrobin${i}@example.com`,
          password: `testpass${i}`
        });
      }
      
      const batchId = `roundrobin-test-${Date.now()}`;
      
      // Enqueue batch
      const result = await this.jobQueue.enqueueBatch(batchId, credentials, {
        batchType: 'TEST',
        chatId: 123456789,
        messageId: 987654321
      });
      
      if (result.queued !== 25) {
        throw new Error(`Expected 25 tasks queued, got ${result.queued}`);
      }
      
      // Analyze proxy assignment distribution
      const proxyAssignments = {};
      
      // Dequeue all tasks to check proxy assignments
      for (let i = 0; i < 25; i++) {
        const taskData = await this.redisClient.executeCommand('lpop', 'queue:tasks');
        if (!taskData) break;
        
        const task = JSON.parse(taskData);
        const proxyId = task.proxyId;
        
        if (!proxyAssignments[proxyId]) {
          proxyAssignments[proxyId] = 0;
        }
        proxyAssignments[proxyId]++;
      }
      
      // Verify round-robin distribution (each proxy should get 5 tasks)
      const proxyIds = Object.keys(proxyAssignments);
      const expectedTasksPerProxy = 5;
      const tolerance = 1; // Allow ±1 task difference
      
      let distributionFair = true;
      let maxDeviation = 0;
      
      for (const proxyId of proxyIds) {
        const taskCount = proxyAssignments[proxyId];
        const deviation = Math.abs(taskCount - expectedTasksPerProxy);
        
        if (deviation > tolerance) {
          distributionFair = false;
        }
        
        maxDeviation = Math.max(maxDeviation, deviation);
      }
      
      this.testResults.roundRobinAssignment = {
        success: distributionFair,
        proxyAssignments,
        expectedTasksPerProxy,
        maxDeviation,
        tolerance,
        message: distributionFair ? 
          'Round-robin assignment working correctly' : 
          `Uneven distribution detected (max deviation: ${maxDeviation})`
      };
      
      log.info('✓ Round-robin assignment test completed', {
        proxyAssignments,
        distributionFair,
        maxDeviation
      });
      
    } catch (error) {
      this.testResults.roundRobinAssignment = {
        success: false,
        message: `Round-robin assignment test failed: ${error.message}`
      };
      throw error;
    }
  }

  async testProxyFailures() {
    log.info('Test 3: Testing proxy failure detection (Requirements 4.4)...');
    
    try {
      // Simulate failures for specific proxies
      const failingProxies = ['p001', 'p003']; // proxy1 and proxy3
      
      const failureResults = {};
      
      for (const proxyId of failingProxies) {
        // Record 3 consecutive failures to mark proxy unhealthy
        for (let i = 0; i < 3; i++) {
          await this.proxyPool.recordProxyResult(proxyId, false);
        }
        
        // Check proxy health after failures
        const healthKey = `proxy:${proxyId}:health`;
        const healthData = await this.redisClient.executeCommand('get', healthKey);
        
        if (!healthData) {
          throw new Error(`Health data not found for proxy ${proxyId}`);
        }
        
        const health = JSON.parse(healthData);
        
        failureResults[proxyId] = {
          consecutiveFailures: health.consecutiveFailures,
          healthy: health.healthy,
          successRate: health.successRate
        };
      }
      
      // Verify proxies are marked unhealthy
      const allMarkedUnhealthy = failingProxies.every(proxyId => 
        !failureResults[proxyId].healthy
      );
      
      if (!allMarkedUnhealthy) {
        throw new Error('Failed proxies should be marked unhealthy');
      }
      
      // Verify consecutive failure counts
      const correctFailureCounts = failingProxies.every(proxyId => 
        failureResults[proxyId].consecutiveFailures >= 3
      );
      
      if (!correctFailureCounts) {
        throw new Error('Consecutive failure counts should be >= 3');
      }
      
      this.testResults.proxyFailures = {
        success: true,
        failingProxies,
        failureResults,
        allMarkedUnhealthy,
        correctFailureCounts,
        message: `${failingProxies.length} proxies successfully marked unhealthy after 3 failures`
      };
      
      log.info('✓ Proxy failure detection test passed', {
        failingProxies,
        allMarkedUnhealthy,
        correctFailureCounts
      });
      
    } catch (error) {
      this.testResults.proxyFailures = {
        success: false,
        message: `Proxy failure detection test failed: ${error.message}`
      };
      throw error;
    }
  }

  async testUnhealthyExclusion() {
    log.info('Test 4: Testing unhealthy proxy exclusion...');
    
    try {
      // Generate more test credentials
      const credentials = [];
      for (let i = 1; i <= 15; i++) {
        credentials.push({
          username: `exclusion${i}@example.com`,
          password: `testpass${i}`
        });
      }
      
      const batchId = `exclusion-test-${Date.now()}`;
      
      // Enqueue batch (should exclude unhealthy proxies)
      const result = await this.jobQueue.enqueueBatch(batchId, credentials, {
        batchType: 'TEST',
        chatId: 123456789,
        messageId: 987654321
      });
      
      if (result.queued !== 15) {
        throw new Error(`Expected 15 tasks queued, got ${result.queued}`);
      }
      
      // Analyze proxy assignments (should only use healthy proxies)
      const proxyAssignments = {};
      const unhealthyProxiesUsed = [];
      
      for (let i = 0; i < 15; i++) {
        const taskData = await this.redisClient.executeCommand('lpop', 'queue:tasks');
        if (!taskData) break;
        
        const task = JSON.parse(taskData);
        const proxyId = task.proxyId;
        
        if (!proxyAssignments[proxyId]) {
          proxyAssignments[proxyId] = 0;
        }
        proxyAssignments[proxyId]++;
        
        // Check if unhealthy proxy was used
        if (['p001', 'p003'].includes(proxyId)) {
          unhealthyProxiesUsed.push(proxyId);
        }
      }
      
      // Verify unhealthy proxies were excluded
      const exclusionWorking = unhealthyProxiesUsed.length === 0;
      
      // Verify only healthy proxies were used
      const healthyProxiesUsed = Object.keys(proxyAssignments);
      const expectedHealthyProxies = ['p002', 'p004', 'p005']; // proxy2, proxy4, proxy5
      
      const onlyHealthyUsed = healthyProxiesUsed.every(proxyId => 
        expectedHealthyProxies.includes(proxyId)
      );
      
      this.testResults.unhealthyExclusion = {
        success: exclusionWorking && onlyHealthyUsed,
        proxyAssignments,
        unhealthyProxiesUsed,
        healthyProxiesUsed,
        expectedHealthyProxies,
        exclusionWorking,
        onlyHealthyUsed,
        message: exclusionWorking && onlyHealthyUsed ? 
          'Unhealthy proxies successfully excluded from assignment' : 
          'Unhealthy proxy exclusion not working correctly'
      };
      
      log.info('✓ Unhealthy proxy exclusion test completed', {
        exclusionWorking,
        onlyHealthyUsed,
        healthyProxiesUsed,
        unhealthyProxiesUsed
      });
      
    } catch (error) {
      this.testResults.unhealthyExclusion = {
        success: false,
        message: `Unhealthy proxy exclusion test failed: ${error.message}`
      };
      throw error;
    }
  }

  async testProxyRecovery() {
    log.info('Test 5: Testing proxy recovery after success (Requirements 4.5)...');
    
    try {
      // Record successful requests for previously failed proxies
      const recoveringProxies = ['p001', 'p003'];
      
      const recoveryResults = {};
      
      for (const proxyId of recoveringProxies) {
        // Record a successful request
        await this.proxyPool.recordProxyResult(proxyId, true);
        
        // Check proxy health after success
        const healthKey = `proxy:${proxyId}:health`;
        const healthData = await this.redisClient.executeCommand('get', healthKey);
        
        if (!healthData) {
          throw new Error(`Health data not found for proxy ${proxyId}`);
        }
        
        const health = JSON.parse(healthData);
        
        recoveryResults[proxyId] = {
          consecutiveFailures: health.consecutiveFailures,
          healthy: health.healthy,
          successRate: health.successRate,
          totalRequests: health.totalRequests,
          successCount: health.successCount
        };
      }
      
      // Verify proxies are restored to healthy status
      const allRestored = recoveringProxies.every(proxyId => 
        recoveryResults[proxyId].healthy
      );
      
      if (!allRestored) {
        throw new Error('Proxies should be restored to healthy status after success');
      }
      
      // Verify consecutive failures reset to 0
      const failuresReset = recoveringProxies.every(proxyId => 
        recoveryResults[proxyId].consecutiveFailures === 0
      );
      
      if (!failuresReset) {
        throw new Error('Consecutive failures should be reset to 0 after success');
      }
      
      // Test that recovered proxies are included in new assignments
      const credentials = [{
        username: 'recovery-test@example.com',
        password: 'recoverypass'
      }];
      
      const batchId = `recovery-test-${Date.now()}`;
      
      // Enqueue single task multiple times to test assignment
      const assignmentResults = [];
      
      for (let i = 0; i < 10; i++) {
        const result = await this.jobQueue.enqueueBatch(`${batchId}-${i}`, credentials, {
          batchType: 'TEST',
          chatId: 123456789,
          messageId: 987654321
        });
        
        const taskData = await this.redisClient.executeCommand('lpop', 'queue:tasks');
        if (taskData) {
          const task = JSON.parse(taskData);
          assignmentResults.push(task.proxyId);
        }
      }
      
      // Check if recovered proxies are being assigned
      const recoveredProxiesAssigned = assignmentResults.some(proxyId => 
        recoveringProxies.includes(proxyId)
      );
      
      this.testResults.proxyRecovery = {
        success: allRestored && failuresReset && recoveredProxiesAssigned,
        recoveringProxies,
        recoveryResults,
        allRestored,
        failuresReset,
        assignmentResults,
        recoveredProxiesAssigned,
        message: allRestored && failuresReset && recoveredProxiesAssigned ? 
          'Proxy recovery working correctly - proxies restored and reassigned' : 
          'Proxy recovery not working as expected'
      };
      
      log.info('✓ Proxy recovery test completed', {
        allRestored,
        failuresReset,
        recoveredProxiesAssigned,
        assignmentResults
      });
      
    } catch (error) {
      this.testResults.proxyRecovery = {
        success: false,
        message: `Proxy recovery test failed: ${error.message}`
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
    log.info('PROXY ROTATION AND HEALTH TRACKING TEST SUMMARY');
    log.info('='.repeat(70));
    
    const tests = [
      { name: 'Proxy Setup', result: this.testResults.proxySetup },
      { name: 'Round-Robin Assignment', result: this.testResults.roundRobinAssignment },
      { name: 'Proxy Failures', result: this.testResults.proxyFailures },
      { name: 'Unhealthy Exclusion', result: this.testResults.unhealthyExclusion },
      { name: 'Proxy Recovery', result: this.testResults.proxyRecovery }
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
      log.info('🎉 All proxy rotation and health tracking tests passed!');
      log.info('✓ Proxy pool can be initialized with multiple proxies');
      log.info('✓ Round-robin assignment distributes tasks fairly');
      log.info('✓ Proxy failures are detected and tracked');
      log.info('✓ Unhealthy proxies are excluded from assignment');
      log.info('✓ Successful proxies are restored to active rotation');
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
module.exports = ProxyRotationHealthTest;

// If run directly, execute test
if (require.main === module) {
  const test = new ProxyRotationHealthTest();
  
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