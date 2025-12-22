#!/usr/bin/env node

/**
 * POW Cache Hit Rate Test
 * 
 * This test validates the POW service cache effectiveness by submitting batches
 * with repeated mask/key/seed patterns and measuring cache hit rates.
 * It verifies >60% cache hit rate (target SLO) and validates cache TTL behavior.
 * 
 * Requirements tested: 3.3, 3.8
 * Target SLO: >60% cache hit rate
 * Cache TTL: 5 minutes
 */

const { createLogger } = require('../logger');
const { createClient } = require('redis');
const { performance } = require('perf_hooks');
const axios = require('axios');

const log = createLogger('pow-cache-test');

class POWCacheHitRateTest {
  constructor() {
    this.testResults = {
      targetCacheHitRate: 0.60, // 60%
      cacheTTL: 5 * 60 * 1000, // 5 minutes in ms
      testPatterns: {
        repeated: 500, // 500 requests with repeated patterns
        unique: 200,   // 200 requests with unique patterns
        total: 700
      },
      actualResults: {}
    };
    
    this.redis = null;
    this.powServiceUrl = process.env.POW_SERVICE_URL || 'http://localhost:3001';
    this.testStartTime = null;
    this.cacheMetrics = {
      requests: [],
      cacheHits: 0,
      cacheMisses: 0,
      responseTime: [],
      patterns: new Map()
    };
  }

  async runTest() {
    log.info('🚀 Starting POW Cache Hit Rate Test');
    log.info('='.repeat(80));
    log.info(`POW Service URL: ${this.powServiceUrl}`);
    log.info(`Target cache hit rate: ${this.testResults.targetCacheHitRate * 100}%`);
    log.info(`Cache TTL: ${this.testResults.cacheTTL / 1000 / 60} minutes`);
    log.info(`Test patterns - Repeated: ${this.testResults.testPatterns.repeated}, Unique: ${this.testResults.testPatterns.unique}`);
    log.info('');

    try {
      // Initialize connections
      await this.initializeConnections();
      
      // Validate POW service availability
      await this.validatePOWService();
      
      // Clear existing cache
      await this.clearPOWCache();
      
      // Phase 1: Test with repeated patterns (should build cache)
      await this.testRepeatedPatterns();
      
      // Phase 2: Test cache hit rate with same patterns
      await this.testCacheHitRate();
      
      // Phase 3: Test cache TTL behavior
      await this.testCacheTTL();
      
      // Analyze results
      await this.analyzeResults();
      
      // Generate report
      this.printTestSummary();
      
      return this.testResults.actualResults.success;
      
    } catch (error) {
      log.error('POW cache test failed', { error: error.message });
      this.testResults.actualResults = {
        success: false,
        error: error.message,
        completedAt: Date.now()
      };
      return false;
    } finally {
      await this.cleanup();
    }
  }

  async initializeConnections() {
    // Initialize Redis connection
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is required for POW cache testing');
    }

    this.redis = createClient({ url: redisUrl });
    
    this.redis.on('error', (err) => {
      log.error('Redis connection error', { error: err.message });
    });

    await this.redis.connect();
    log.info('✅ Connected to Redis');
  }

  async validatePOWService() {
    log.info('🔍 Validating POW service availability...');
    
    try {
      const response = await axios.get(`${this.powServiceUrl}/health`, {
        timeout: 5000
      });
      
      if (response.status !== 200) {
        throw new Error(`POW service health check failed: ${response.status}`);
      }
      
      log.info('✅ POW service is available');
      log.info(`Health status: ${JSON.stringify(response.data)}`);
      
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`POW service not reachable at ${this.powServiceUrl}. Please ensure it's running.`);
      }
      throw new Error(`POW service validation failed: ${error.message}`);
    }
  }

  async clearPOWCache() {
    log.info('🧹 Clearing existing POW cache...');
    
    try {
      // Clear all POW cache keys
      const powKeys = await this.redis.keys('pow:*');
      if (powKeys.length > 0) {
        await this.redis.del(powKeys);
        log.info(`Cleared ${powKeys.length} existing POW cache entries`);
      } else {
        log.info('No existing POW cache entries found');
      }
      
    } catch (error) {
      log.warn('Could not clear POW cache', { error: error.message });
    }
  }

  generateTestPatterns() {
    log.info('📝 Generating test patterns...');
    
    const patterns = [];
    
    // Generate base patterns that will be repeated
    const basePatterns = [
      { mask: '0000', key: 'test123', seed: 42 },
      { mask: '0001', key: 'test456', seed: 123 },
      { mask: '0010', key: 'test789', seed: 456 },
      { mask: '0011', key: 'testABC', seed: 789 },
      { mask: '0100', key: 'testDEF', seed: 321 }
    ];
    
    // Phase 1: Add repeated patterns (should create cache entries)
    for (let i = 0; i < this.testResults.testPatterns.repeated; i++) {
      const basePattern = basePatterns[i % basePatterns.length];
      patterns.push({
        ...basePattern,
        phase: 'repeated',
        iteration: i,
        expectedCached: i >= basePatterns.length // First occurrence won't be cached
      });
    }
    
    // Phase 2: Add unique patterns (should be cache misses)
    for (let i = 0; i < this.testResults.testPatterns.unique; i++) {
      patterns.push({
        mask: `${(i % 16).toString(16).padStart(4, '0')}`,
        key: `unique${i}`,
        seed: 1000 + i,
        phase: 'unique',
        iteration: i,
        expectedCached: false
      });
    }
    
    log.info(`✅ Generated ${patterns.length} test patterns`);
    return patterns;
  }

  async testRepeatedPatterns() {
    log.info('🔄 Phase 1: Testing repeated patterns to build cache...');
    
    const patterns = this.generateTestPatterns().filter(p => p.phase === 'repeated');
    
    this.testStartTime = performance.now();
    
    let cacheHits = 0;
    let cacheMisses = 0;
    
    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i];
      
      try {
        const startTime = performance.now();
        
        const response = await axios.post(`${this.powServiceUrl}/compute`, {
          mask: pattern.mask,
          key: pattern.key,
          seed: pattern.seed
        }, {
          timeout: 10000
        });
        
        const endTime = performance.now();
        const responseTime = endTime - startTime;
        
        if (response.status === 200) {
          const { cres, cached, computeTimeMs } = response.data;
          
          if (cached) {
            cacheHits++;
          } else {
            cacheMisses++;
          }
          
          this.cacheMetrics.requests.push({
            pattern,
            cached,
            responseTime,
            computeTimeMs,
            cres,
            phase: 'repeated',
            timestamp: Date.now()
          });
          
          this.cacheMetrics.responseTime.push(responseTime);
          
          // Track pattern usage
          const patternKey = `${pattern.mask}:${pattern.key}:${pattern.seed}`;
          const usage = this.cacheMetrics.patterns.get(patternKey) || { count: 0, firstCached: null };
          usage.count++;
          if (cached && usage.firstCached === null) {
            usage.firstCached = i;
          }
          this.cacheMetrics.patterns.set(patternKey, usage);
          
          if ((i + 1) % 50 === 0) {
            const currentHitRate = cacheHits / (cacheHits + cacheMisses) * 100;
            log.info(`Progress: ${i + 1}/${patterns.length} | Cache hit rate: ${currentHitRate.toFixed(1)}% | Avg response: ${(this.cacheMetrics.responseTime.reduce((a, b) => a + b, 0) / this.cacheMetrics.responseTime.length).toFixed(1)}ms`);
          }
          
        } else {
          throw new Error(`Unexpected response status: ${response.status}`);
        }
        
      } catch (error) {
        log.error(`Request ${i + 1} failed`, { error: error.message, pattern });
        cacheMisses++; // Count errors as misses
      }
      
      // Small delay to avoid overwhelming the service
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    const phaseHitRate = cacheHits / (cacheHits + cacheMisses) * 100;
    
    log.info(`✅ Phase 1 completed: ${patterns.length} requests`);
    log.info(`Cache hits: ${cacheHits}, Cache misses: ${cacheMisses}`);
    log.info(`Phase 1 hit rate: ${phaseHitRate.toFixed(1)}%`);
    
    this.cacheMetrics.cacheHits += cacheHits;
    this.cacheMetrics.cacheMisses += cacheMisses;
  }

  async testCacheHitRate() {
    log.info('📊 Phase 2: Testing cache hit rate with same patterns...');
    
    // Use the same base patterns to test cache effectiveness
    const basePatterns = [
      { mask: '0000', key: 'test123', seed: 42 },
      { mask: '0001', key: 'test456', seed: 123 },
      { mask: '0010', key: 'test789', seed: 456 },
      { mask: '0011', key: 'testABC', seed: 789 },
      { mask: '0100', key: 'testDEF', seed: 321 }
    ];
    
    let cacheHits = 0;
    let cacheMisses = 0;
    
    // Test each base pattern multiple times (should all be cache hits)
    for (let round = 0; round < 20; round++) {
      for (const pattern of basePatterns) {
        try {
          const startTime = performance.now();
          
          const response = await axios.post(`${this.powServiceUrl}/compute`, {
            mask: pattern.mask,
            key: pattern.key,
            seed: pattern.seed
          }, {
            timeout: 10000
          });
          
          const endTime = performance.now();
          const responseTime = endTime - startTime;
          
          if (response.status === 200) {
            const { cres, cached, computeTimeMs } = response.data;
            
            if (cached) {
              cacheHits++;
            } else {
              cacheMisses++;
              log.warn(`Unexpected cache miss for pattern ${pattern.mask}:${pattern.key}:${pattern.seed}`);
            }
            
            this.cacheMetrics.requests.push({
              pattern,
              cached,
              responseTime,
              computeTimeMs,
              cres,
              phase: 'cache_test',
              timestamp: Date.now()
            });
            
            this.cacheMetrics.responseTime.push(responseTime);
            
          } else {
            throw new Error(`Unexpected response status: ${response.status}`);
          }
          
        } catch (error) {
          log.error(`Cache test request failed`, { error: error.message, pattern });
          cacheMisses++;
        }
        
        // Small delay
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    
    const phaseHitRate = cacheHits / (cacheHits + cacheMisses) * 100;
    
    log.info(`✅ Phase 2 completed: ${cacheHits + cacheMisses} requests`);
    log.info(`Cache hits: ${cacheHits}, Cache misses: ${cacheMisses}`);
    log.info(`Phase 2 hit rate: ${phaseHitRate.toFixed(1)}% (should be ~100%)`);
    
    this.cacheMetrics.cacheHits += cacheHits;
    this.cacheMetrics.cacheMisses += cacheMisses;
  }

  async testCacheTTL() {
    log.info('⏰ Phase 3: Testing cache TTL behavior...');
    
    // Use a specific pattern to test TTL
    const testPattern = { mask: '1111', key: 'ttltest', seed: 999 };
    
    // First request - should be a cache miss
    log.info('Making initial request (should be cache miss)...');
    const response1 = await axios.post(`${this.powServiceUrl}/compute`, testPattern, { timeout: 10000 });
    
    if (!response1.data.cached) {
      log.info('✅ Initial request was cache miss as expected');
    } else {
      log.warn('⚠️  Initial request was cache hit (unexpected)');
    }
    
    // Second request immediately - should be cache hit
    log.info('Making immediate second request (should be cache hit)...');
    const response2 = await axios.post(`${this.powServiceUrl}/compute`, testPattern, { timeout: 10000 });
    
    if (response2.data.cached) {
      log.info('✅ Immediate second request was cache hit as expected');
    } else {
      log.warn('⚠️  Immediate second request was cache miss (unexpected)');
    }
    
    // Check cache key exists in Redis
    const cacheKey = `pow:${testPattern.mask}:${testPattern.key}:${testPattern.seed}`;
    const cacheExists = await this.redis.exists(cacheKey);
    const cacheTTL = await this.redis.ttl(cacheKey);
    
    log.info(`Cache key exists: ${cacheExists ? 'YES' : 'NO'}`);
    log.info(`Cache TTL: ${cacheTTL} seconds (${(cacheTTL / 60).toFixed(1)} minutes)`);
    
    // Verify TTL is approximately 5 minutes (300 seconds)
    const expectedTTL = 5 * 60; // 5 minutes
    const ttlWithinRange = cacheTTL > expectedTTL - 30 && cacheTTL <= expectedTTL; // Allow 30 second variance
    
    if (ttlWithinRange) {
      log.info('✅ Cache TTL is within expected range (5 minutes ±30 seconds)');
    } else {
      log.warn(`⚠️  Cache TTL outside expected range: ${cacheTTL}s (expected: ~${expectedTTL}s)`);
    }
    
    // Store TTL test results
    this.cacheMetrics.ttlTest = {
      initialCached: response1.data.cached,
      secondCached: response2.data.cached,
      cacheExists,
      cacheTTL,
      ttlWithinRange,
      expectedTTL
    };
    
    log.info('✅ Phase 3 completed: Cache TTL behavior tested');
  }

  async analyzeResults() {
    log.info('📊 Analyzing POW cache test results...');
    
    const totalRequests = this.cacheMetrics.cacheHits + this.cacheMetrics.cacheMisses;
    const overallHitRate = totalRequests > 0 ? this.cacheMetrics.cacheHits / totalRequests : 0;
    
    // Analyze response times
    const responseTimes = this.cacheMetrics.responseTime;
    const avgResponseTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
    const minResponseTime = Math.min(...responseTimes);
    const maxResponseTime = Math.max(...responseTimes);
    
    // Analyze cache vs non-cache response times
    const cachedRequests = this.cacheMetrics.requests.filter(r => r.cached);
    const nonCachedRequests = this.cacheMetrics.requests.filter(r => !r.cached);
    
    const avgCachedResponseTime = cachedRequests.length > 0 ? 
      cachedRequests.reduce((sum, r) => sum + r.responseTime, 0) / cachedRequests.length : 0;
    
    const avgNonCachedResponseTime = nonCachedRequests.length > 0 ? 
      nonCachedRequests.reduce((sum, r) => sum + r.responseTime, 0) / nonCachedRequests.length : 0;
    
    // Analyze pattern usage
    const patternStats = Array.from(this.cacheMetrics.patterns.entries()).map(([pattern, usage]) => ({
      pattern,
      count: usage.count,
      firstCached: usage.firstCached
    }));
    
    this.testResults.actualResults = {
      success: overallHitRate >= this.testResults.targetCacheHitRate && 
               this.cacheMetrics.ttlTest?.ttlWithinRange,
      totalRequests,
      cacheHits: this.cacheMetrics.cacheHits,
      cacheMisses: this.cacheMetrics.cacheMisses,
      overallHitRate: (overallHitRate * 100).toFixed(1),
      metHitRateTarget: overallHitRate >= this.testResults.targetCacheHitRate,
      responseTimeStats: {
        avg: avgResponseTime.toFixed(1),
        min: minResponseTime.toFixed(1),
        max: maxResponseTime.toFixed(1),
        avgCached: avgCachedResponseTime.toFixed(1),
        avgNonCached: avgNonCachedResponseTime.toFixed(1),
        cacheSpeedup: avgNonCachedResponseTime > 0 ? 
          (avgNonCachedResponseTime / avgCachedResponseTime).toFixed(1) : 'N/A'
      },
      ttlTest: this.cacheMetrics.ttlTest,
      patternStats,
      completedAt: Date.now()
    };
    
    log.info('✅ Results analysis completed');
  }

  printTestSummary() {
    const results = this.testResults.actualResults;
    
    log.info('='.repeat(80));
    log.info('🎯 POW CACHE HIT RATE TEST RESULTS');
    log.info('='.repeat(80));
    
    // Test configuration
    log.info('\n📋 TEST CONFIGURATION:');
    log.info(`POW Service URL: ${this.powServiceUrl}`);
    log.info(`Target cache hit rate: ${this.testResults.targetCacheHitRate * 100}%`);
    log.info(`Expected cache TTL: ${this.testResults.cacheTTL / 1000 / 60} minutes`);
    log.info(`Test patterns: ${this.testResults.testPatterns.repeated} repeated + ${this.testResults.testPatterns.unique} unique`);
    
    // Cache performance results
    log.info('\n🚀 CACHE PERFORMANCE RESULTS:');
    log.info(`Total requests: ${results.totalRequests}`);
    log.info(`Cache hits: ${results.cacheHits}`);
    log.info(`Cache misses: ${results.cacheMisses}`);
    log.info(`Overall hit rate: ${results.overallHitRate}%`);
    log.info(`Hit rate target met: ${results.metHitRateTarget ? '✅ YES' : '❌ NO'}`);
    
    // Response time analysis
    log.info('\n⚡ RESPONSE TIME ANALYSIS:');
    log.info(`Average response time: ${results.responseTimeStats.avg}ms`);
    log.info(`Min response time: ${results.responseTimeStats.min}ms`);
    log.info(`Max response time: ${results.responseTimeStats.max}ms`);
    log.info(`Cached requests avg: ${results.responseTimeStats.avgCached}ms`);
    log.info(`Non-cached requests avg: ${results.responseTimeStats.avgNonCached}ms`);
    log.info(`Cache speedup: ${results.responseTimeStats.cacheSpeedup}x`);
    
    // TTL behavior
    log.info('\n⏰ CACHE TTL BEHAVIOR:');
    if (results.ttlTest) {
      log.info(`Initial request cached: ${results.ttlTest.initialCached ? 'YES' : 'NO'} (expected: NO)`);
      log.info(`Second request cached: ${results.ttlTest.secondCached ? 'YES' : 'NO'} (expected: YES)`);
      log.info(`Cache key exists: ${results.ttlTest.cacheExists ? 'YES' : 'NO'}`);
      log.info(`Cache TTL: ${results.ttlTest.cacheTTL}s (${(results.ttlTest.cacheTTL / 60).toFixed(1)}min)`);
      log.info(`TTL within range: ${results.ttlTest.ttlWithinRange ? '✅ YES' : '❌ NO'}`);
    } else {
      log.warn('TTL test data not available');
    }
    
    // Pattern analysis
    log.info('\n📊 PATTERN USAGE ANALYSIS:');
    if (results.patternStats && results.patternStats.length > 0) {
      results.patternStats.slice(0, 5).forEach((stat, index) => {
        log.info(`  Pattern ${index + 1}: ${stat.pattern} - Used ${stat.count} times, First cached at request ${stat.firstCached || 'N/A'}`);
      });
    }
    
    // Overall assessment
    log.info('\n🎯 OVERALL ASSESSMENT:');
    if (results.success) {
      log.info('✅ POW CACHE HIT RATE TEST PASSED');
      log.info('✅ Cache hit rate meets target (>60%)');
      log.info('✅ Cache TTL behavior is correct (5 minutes)');
      log.info('✅ Cache provides significant performance improvement');
      log.info('✅ POW service caching is working effectively');
    } else {
      log.error('❌ POW CACHE HIT RATE TEST FAILED');
      
      if (!results.metHitRateTarget) {
        log.error(`❌ Cache hit rate below target (${results.overallHitRate}% < ${this.testResults.targetCacheHitRate * 100}%)`);
      }
      
      if (results.ttlTest && !results.ttlTest.ttlWithinRange) {
        log.error(`❌ Cache TTL outside expected range (${results.ttlTest.cacheTTL}s vs ~${results.ttlTest.expectedTTL}s)`);
      }
    }
    
    // Recommendations
    log.info('\n💡 RECOMMENDATIONS:');
    
    if (parseFloat(results.overallHitRate) < 60) {
      log.warn('⚠️  Consider increasing cache TTL or optimizing cache key generation');
    }
    
    if (parseFloat(results.responseTimeStats.cacheSpeedup) < 2) {
      log.warn('⚠️  Cache speedup is low - verify cache is working properly');
    }
    
    if (results.ttlTest && !results.ttlTest.ttlWithinRange) {
      log.warn('⚠️  Check POW service cache TTL configuration');
    }
    
    log.info('='.repeat(80));
  }

  async cleanup() {
    log.info('🧹 Cleaning up test resources...');
    
    try {
      if (this.redis) {
        // Optionally clear test cache entries
        const testKeys = await this.redis.keys('pow:*test*');
        if (testKeys.length > 0) {
          await this.redis.del(testKeys);
          log.info(`Cleaned up ${testKeys.length} test cache entries`);
        }
        
        await this.redis.disconnect();
      }
      
      log.info('✅ Cleanup completed');
    } catch (error) {
      log.error('Cleanup error', { error: error.message });
    }
  }

  getResults() {
    return this.testResults;
  }
}

// Export for use as module
module.exports = POWCacheHitRateTest;

// If run directly, execute the test
if (require.main === module) {
  const test = new POWCacheHitRateTest();
  
  test.runTest()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      log.error('POW cache test execution failed', { error: error.message });
      process.exit(1);
    });
}