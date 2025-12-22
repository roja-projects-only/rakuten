/**
 * =============================================================================
 * POW SERVICE INTEGRATION TEST
 * =============================================================================
 * 
 * Test script to verify POW service integration with existing Railway deployment.
 * Tests:
 * 1. POW service is called for credential checks
 * 2. Fallback works when POW service is stopped
 * 3. Cache hit rates and response times monitoring
 * 
 * Requirements: 3.4, 3.8
 * =============================================================================
 */

const { createLogger } = require('../logger');
const powServiceClient = require('../automation/http/fingerprinting/powServiceClient');
const { computeCresFromMdata } = require('../automation/http/fingerprinting/challengeGenerator');

const log = createLogger('pow-integration-test');

class POWIntegrationTest {
  constructor() {
    this.testResults = {
      serviceConnection: null,
      serviceComputation: null,
      fallbackTest: null,
      performanceTest: null,
      cacheTest: null
    };
  }

  /**
   * Run all integration tests
   */
  async runAllTests() {
    log.info('Starting POW service integration tests...');
    
    try {
      // Test 1: Service connection
      await this.testServiceConnection();
      
      // Test 2: Service computation vs local computation
      await this.testServiceComputation();
      
      // Test 3: Fallback behavior
      await this.testFallbackBehavior();
      
      // Test 4: Performance comparison
      await this.testPerformance();
      
      // Test 5: Cache behavior
      await this.testCacheBehavior();
      
      // Print summary
      this.printTestSummary();
      
    } catch (error) {
      log.error('Integration test failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Test 1: Verify POW service connection
   */
  async testServiceConnection() {
    log.info('Test 1: Testing POW service connection...');
    
    try {
      const isConnected = await powServiceClient.testConnection();
      
      this.testResults.serviceConnection = {
        success: isConnected,
        message: isConnected ? 'POW service is reachable' : 'POW service is not reachable',
        timestamp: new Date().toISOString()
      };
      
      log.info(`Service connection test: ${isConnected ? 'PASS' : 'FAIL'}`);
      
    } catch (error) {
      this.testResults.serviceConnection = {
        success: false,
        message: `Connection test failed: ${error.message}`,
        timestamp: new Date().toISOString()
      };
      
      log.error('Service connection test: FAIL', { error: error.message });
    }
  }

  /**
   * Test 2: Compare service computation with local computation
   */
  async testServiceComputation() {
    log.info('Test 2: Testing POW service computation...');
    
    const testParams = {
      mask: '0000',
      key: 'abc123',
      seed: 12345
    };
    
    try {
      // Test service computation
      const startTime = Date.now();
      const serviceCres = await powServiceClient.computeCres(testParams);
      const serviceTime = Date.now() - startTime;
      
      // Test local computation for comparison
      const localStartTime = Date.now();
      const localCres = computeCresFromMdata({
        body: testParams
      });
      const localTime = Date.now() - localStartTime;
      
      // Both should produce valid cres (16 characters)
      const serviceValid = serviceCres && serviceCres.length === 16;
      const localValid = localCres && localCres.length === 16;
      
      this.testResults.serviceComputation = {
        success: serviceValid && localValid,
        serviceTime,
        localTime,
        serviceCres: serviceCres.substring(0, 8) + '...',
        localCres: localCres.substring(0, 8) + '...',
        message: serviceValid && localValid ? 
          'Both service and local computation produced valid cres' :
          'One or both computations failed',
        timestamp: new Date().toISOString()
      };
      
      log.info(`Service computation test: ${serviceValid && localValid ? 'PASS' : 'FAIL'}`, {
        serviceTime,
        localTime,
        serviceValid,
        localValid
      });
      
    } catch (error) {
      this.testResults.serviceComputation = {
        success: false,
        message: `Computation test failed: ${error.message}`,
        timestamp: new Date().toISOString()
      };
      
      log.error('Service computation test: FAIL', { error: error.message });
    }
  }

  /**
   * Test 3: Test fallback behavior when service is unavailable
   */
  async testFallbackBehavior() {
    log.info('Test 3: Testing fallback behavior...');
    
    const testParams = {
      mask: '0001',
      key: 'def456',
      seed: 67890
    };
    
    try {
      // Create a client with invalid service URL to simulate unavailability
      const { POWServiceClient } = require('../automation/http/fingerprinting/powServiceClient');
      const fallbackClient = new POWServiceClient({
        serviceUrl: 'http://localhost:9999', // Non-existent service
        timeout: 1000 // Short timeout
      });
      
      const startTime = Date.now();
      const fallbackCres = await fallbackClient.computeCres(testParams);
      const fallbackTime = Date.now() - startTime;
      
      // Should still produce valid cres via fallback
      const fallbackValid = fallbackCres && fallbackCres.length === 16;
      
      // Check client stats to verify fallback was used
      const stats = fallbackClient.getStats();
      const fallbackUsed = stats.fallback.total > 0;
      
      this.testResults.fallbackTest = {
        success: fallbackValid && fallbackUsed,
        fallbackTime,
        fallbackCres: fallbackCres.substring(0, 8) + '...',
        fallbackCount: stats.fallback.total,
        message: fallbackValid && fallbackUsed ? 
          'Fallback computation worked correctly' :
          'Fallback computation failed',
        timestamp: new Date().toISOString()
      };
      
      log.info(`Fallback test: ${fallbackValid && fallbackUsed ? 'PASS' : 'FAIL'}`, {
        fallbackTime,
        fallbackValid,
        fallbackUsed,
        fallbackCount: stats.fallback.total
      });
      
    } catch (error) {
      this.testResults.fallbackTest = {
        success: false,
        message: `Fallback test failed: ${error.message}`,
        timestamp: new Date().toISOString()
      };
      
      log.error('Fallback test: FAIL', { error: error.message });
    }
  }

  /**
   * Test 4: Performance comparison between service and local computation
   */
  async testPerformance() {
    log.info('Test 4: Testing performance...');
    
    const testCases = [
      { mask: '0000', key: 'test1', seed: 1001 },
      { mask: '0001', key: 'test2', seed: 1002 },
      { mask: '0010', key: 'test3', seed: 1003 },
      { mask: '0011', key: 'test4', seed: 1004 },
      { mask: '0100', key: 'test5', seed: 1005 }
    ];
    
    try {
      const serviceTimes = [];
      const localTimes = [];
      
      // Test service performance
      for (const testCase of testCases) {
        const startTime = Date.now();
        await powServiceClient.computeCres(testCase);
        serviceTimes.push(Date.now() - startTime);
        
        // Small delay between requests
        await this.sleep(100);
      }
      
      // Test local performance
      for (const testCase of testCases) {
        const startTime = Date.now();
        computeCresFromMdata({ body: testCase });
        localTimes.push(Date.now() - startTime);
      }
      
      const avgServiceTime = serviceTimes.reduce((a, b) => a + b, 0) / serviceTimes.length;
      const avgLocalTime = localTimes.reduce((a, b) => a + b, 0) / localTimes.length;
      
      // Get client stats
      const stats = powServiceClient.getStats();
      
      this.testResults.performanceTest = {
        success: true,
        avgServiceTime: Math.round(avgServiceTime),
        avgLocalTime: Math.round(avgLocalTime),
        serviceTimes,
        localTimes,
        clientStats: stats,
        message: `Service avg: ${Math.round(avgServiceTime)}ms, Local avg: ${Math.round(avgLocalTime)}ms`,
        timestamp: new Date().toISOString()
      };
      
      log.info('Performance test: PASS', {
        avgServiceTime: Math.round(avgServiceTime),
        avgLocalTime: Math.round(avgLocalTime),
        successRate: stats.requests.successRate,
        fallbackRate: stats.fallback.rate
      });
      
    } catch (error) {
      this.testResults.performanceTest = {
        success: false,
        message: `Performance test failed: ${error.message}`,
        timestamp: new Date().toISOString()
      };
      
      log.error('Performance test: FAIL', { error: error.message });
    }
  }

  /**
   * Test 5: Test cache behavior
   */
  async testCacheBehavior() {
    log.info('Test 5: Testing cache behavior...');
    
    const testParams = {
      mask: '1111',
      key: 'cache_test',
      seed: 99999
    };
    
    try {
      // First request (should be cache miss)
      const startTime1 = Date.now();
      const cres1 = await powServiceClient.computeCres(testParams);
      const time1 = Date.now() - startTime1;
      
      // Second request (should be cache hit if service is available)
      const startTime2 = Date.now();
      const cres2 = await powServiceClient.computeCres(testParams);
      const time2 = Date.now() - startTime2;
      
      // Third request (should also be cache hit)
      const startTime3 = Date.now();
      const cres3 = await powServiceClient.computeCres(testParams);
      const time3 = Date.now() - startTime3;
      
      // All results should be identical
      const resultsMatch = cres1 === cres2 && cres2 === cres3;
      
      // Second and third requests should be faster (cache hits)
      const cacheImprovement = time2 < time1 && time3 < time1;
      
      const stats = powServiceClient.getStats();
      
      this.testResults.cacheTest = {
        success: resultsMatch,
        times: [time1, time2, time3],
        resultsMatch,
        cacheImprovement,
        cacheHitRate: stats.localCache.hitRate,
        message: resultsMatch ? 
          'Cache behavior working correctly' : 
          'Cache results inconsistent',
        timestamp: new Date().toISOString()
      };
      
      log.info(`Cache test: ${resultsMatch ? 'PASS' : 'FAIL'}`, {
        times: [time1, time2, time3],
        resultsMatch,
        cacheImprovement,
        cacheHitRate: stats.localCache.hitRate
      });
      
    } catch (error) {
      this.testResults.cacheTest = {
        success: false,
        message: `Cache test failed: ${error.message}`,
        timestamp: new Date().toISOString()
      };
      
      log.error('Cache test: FAIL', { error: error.message });
    }
  }

  /**
   * Print test summary
   */
  printTestSummary() {
    log.info('='.repeat(60));
    log.info('POW SERVICE INTEGRATION TEST SUMMARY');
    log.info('='.repeat(60));
    
    const tests = [
      { name: 'Service Connection', result: this.testResults.serviceConnection },
      { name: 'Service Computation', result: this.testResults.serviceComputation },
      { name: 'Fallback Behavior', result: this.testResults.fallbackTest },
      { name: 'Performance Test', result: this.testResults.performanceTest },
      { name: 'Cache Behavior', result: this.testResults.cacheTest }
    ];
    
    let passCount = 0;
    let totalCount = tests.length;
    
    tests.forEach(test => {
      const status = test.result?.success ? 'PASS' : 'FAIL';
      const message = test.result?.message || 'No result';
      
      log.info(`${test.name}: ${status} - ${message}`);
      
      if (test.result?.success) {
        passCount++;
      }
    });
    
    log.info('='.repeat(60));
    log.info(`OVERALL RESULT: ${passCount}/${totalCount} tests passed`);
    
    if (passCount === totalCount) {
      log.info('✅ All tests passed! POW service integration is working correctly.');
    } else {
      log.warn(`⚠️  ${totalCount - passCount} test(s) failed. Check the results above.`);
    }
    
    // Print detailed stats if available
    const stats = powServiceClient.getStats();
    log.info('Final POW Client Statistics:', stats);
    
    log.info('='.repeat(60));
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get test results for programmatic access
   */
  getResults() {
    return this.testResults;
  }
}

// Export for use as module
module.exports = POWIntegrationTest;

// If run directly, execute tests
if (require.main === module) {
  const test = new POWIntegrationTest();
  
  test.runAllTests()
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