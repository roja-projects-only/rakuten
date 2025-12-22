#!/usr/bin/env node

/**
 * Performance Test Runner
 * 
 * Executes all performance and optimization tests for the distributed worker architecture.
 * This script runs performance tests in sequence and provides detailed performance metrics.
 */

const { createLogger } = require('../logger');
const { execSync } = require('child_process');

const log = createLogger('performance-test-runner');

class PerformanceTestRunner {
  constructor() {
    this.testResults = {};
    this.performanceTests = [
      {
        name: 'Load Test 10k Batch',
        script: 'test-load-10k-batch.js',
        description: 'Tests system performance with 10k credential batch',
        requirements: ['6.5'],
        timeout: 150000, // 2.5 minutes timeout
        category: 'Load Testing'
      },
      {
        name: 'Concurrent Batch Processing',
        script: 'test-concurrent-batch-processing.js',
        description: 'Tests concurrent processing of multiple batches',
        requirements: ['1.3', '5.1', '5.2'],
        timeout: 120000, // 2 minutes timeout
        category: 'Concurrency Testing'
      },
      {
        name: 'POW Cache Hit Rate',
        script: 'test-pow-cache-hit-rate.js',
        description: 'Tests POW service cache effectiveness',
        requirements: ['3.3', '3.8'],
        timeout: 60000, // 1 minute timeout
        category: 'Cache Performance'
      },
      {
        name: 'Proxy Fairness',
        script: 'test-proxy-fairness.js',
        description: 'Tests fair proxy distribution across tasks',
        requirements: ['4.2'],
        timeout: 90000, // 1.5 minutes timeout
        category: 'Load Balancing'
      }
    ];
  }

  async runPerformanceTests() {
    log.info('🚀 Starting Performance Test Suite...');
    log.info(`Running ${this.performanceTests.length} performance tests`);
    log.info('='.repeat(80));
    
    let totalPassed = 0;
    let totalFailed = 0;
    const categoryResults = {};
    
    for (let i = 0; i < this.performanceTests.length; i++) {
      const test = this.performanceTests[i];
      
      log.info(`\n🏃 Performance Test ${i + 1}/${this.performanceTests.length}: ${test.name}`);
      log.info(`Category: ${test.category}`);
      log.info(`Description: ${test.description}`);
      log.info(`Requirements: ${test.requirements.join(', ')}`);
      log.info(`Script: ${test.script}`);
      log.info(`Timeout: ${test.timeout / 1000}s`);
      log.info('-'.repeat(60));
      
      try {
        const startTime = Date.now();
        
        // Run the performance test
        const output = execSync(`node scripts/${test.script}`, {
          encoding: 'utf8',
          timeout: test.timeout,
          stdio: 'pipe'
        });
        
        const duration = Date.now() - startTime;
        
        this.testResults[test.name] = {
          success: true,
          duration,
          output: output.trim(),
          requirements: test.requirements,
          category: test.category,
          message: 'Performance test completed successfully'
        };
        
        totalPassed++;
        
        // Track category results
        if (!categoryResults[test.category]) {
          categoryResults[test.category] = { passed: 0, failed: 0, total: 0 };
        }
        categoryResults[test.category].passed++;
        categoryResults[test.category].total++;
        
        log.info(`✅ ${test.name}: PASSED (${duration}ms)`);
        
        // Extract performance metrics from output
        const performanceMetrics = this.extractPerformanceMetrics(output, test.name);
        if (performanceMetrics) {
          log.info('📊 Performance Metrics:');
          Object.entries(performanceMetrics).forEach(([metric, value]) => {
            log.info(`  ${metric}: ${value}`);
          });
        }
        
      } catch (error) {
        const duration = Date.now() - Date.now(); // Will be 0 for failed tests
        
        this.testResults[test.name] = {
          success: false,
          duration,
          error: error.message,
          requirements: test.requirements,
          category: test.category,
          message: 'Performance test failed'
        };
        
        totalFailed++;
        
        // Track category results
        if (!categoryResults[test.category]) {
          categoryResults[test.category] = { passed: 0, failed: 0, total: 0 };
        }
        categoryResults[test.category].failed++;
        categoryResults[test.category].total++;
        
        log.error(`❌ ${test.name}: FAILED`);
        log.error(`Error: ${error.message}`);
        
        // Show stderr output if available
        if (error.stderr) {
          log.error('Error output:');
          log.error(error.stderr.toString());
        }
      }
      
      // Delay between tests to allow system recovery
      if (i < this.performanceTests.length - 1) {
        log.info('⏳ Waiting 10 seconds before next test...');
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
    
    // Generate performance report
    this.generatePerformanceReport(totalPassed, totalFailed, categoryResults);
    
    return totalFailed === 0;
  }

  extractPerformanceMetrics(output, testName) {
    const metrics = {};
    
    try {
      const lines = output.split('\n');
      
      // Extract common performance metrics
      for (const line of lines) {
        // Throughput metrics
        if (line.includes('throughput:') || line.includes('Throughput:')) {
          const match = line.match(/(\d+\.?\d*)\s*(credentials?\/min|tasks?\/min|requests?\/min)/i);
          if (match) {
            metrics['Throughput'] = `${match[1]} ${match[2]}`;
          }
        }
        
        // Duration metrics
        if (line.includes('duration:') || line.includes('Duration:')) {
          const match = line.match(/(\d+\.?\d*)\s*(minutes?|seconds?|ms)/i);
          if (match) {
            metrics['Duration'] = `${match[1]} ${match[2]}`;
          }
        }
        
        // Cache hit rate
        if (line.includes('hit rate:') || line.includes('Hit rate:')) {
          const match = line.match(/(\d+\.?\d*)%/);
          if (match) {
            metrics['Cache Hit Rate'] = `${match[1]}%`;
          }
        }
        
        // Completion rate
        if (line.includes('completion rate:') || line.includes('Completion rate:')) {
          const match = line.match(/(\d+\.?\d*)%/);
          if (match) {
            metrics['Completion Rate'] = `${match[1]}%`;
          }
        }
        
        // Response time
        if (line.includes('response time:') || line.includes('Response time:')) {
          const match = line.match(/(\d+\.?\d*)\s*ms/);
          if (match) {
            metrics['Avg Response Time'] = `${match[1]}ms`;
          }
        }
        
        // Queue depth
        if (line.includes('queue depth:') || line.includes('Queue depth:')) {
          const match = line.match(/(\d+)/);
          if (match) {
            metrics['Max Queue Depth'] = match[1];
          }
        }
        
        // Worker count
        if (line.includes('workers:') || line.includes('Workers:')) {
          const match = line.match(/(\d+)/);
          if (match) {
            metrics['Active Workers'] = match[1];
          }
        }
      }
      
      // Test-specific metrics
      if (testName === 'Load Test 10k Batch') {
        // Look for specific load test metrics
        for (const line of lines) {
          if (line.includes('credentials/minute')) {
            const match = line.match(/(\d+\.?\d*)\s*credentials\/minute/);
            if (match) {
              metrics['Credential Processing Rate'] = `${match[1]} creds/min`;
            }
          }
        }
      }
      
      if (testName === 'POW Cache Hit Rate') {
        // Look for cache-specific metrics
        for (const line of lines) {
          if (line.includes('cache speedup:') || line.includes('Cache speedup:')) {
            const match = line.match(/(\d+\.?\d*)x/);
            if (match) {
              metrics['Cache Speedup'] = `${match[1]}x`;
            }
          }
        }
      }
      
    } catch (error) {
      log.warn(`Could not extract metrics for ${testName}`, { error: error.message });
    }
    
    return Object.keys(metrics).length > 0 ? metrics : null;
  }

  generatePerformanceReport(totalPassed, totalFailed, categoryResults) {
    log.info('\n' + '='.repeat(80));
    log.info('🎯 PERFORMANCE TEST SUITE REPORT');
    log.info('='.repeat(80));
    
    // Overall results
    log.info('\n📊 OVERALL RESULTS:');
    log.info('-'.repeat(40));
    log.info(`Total Tests: ${this.performanceTests.length}`);
    log.info(`Passed: ${totalPassed}`);
    log.info(`Failed: ${totalFailed}`);
    log.info(`Success Rate: ${Math.round(totalPassed / this.performanceTests.length * 100)}%`);
    
    // Category breakdown
    log.info('\n📋 CATEGORY BREAKDOWN:');
    log.info('-'.repeat(40));
    
    Object.entries(categoryResults).forEach(([category, results]) => {
      const successRate = Math.round(results.passed / results.total * 100);
      const status = results.failed === 0 ? '✅' : '❌';
      log.info(`${status} ${category}: ${results.passed}/${results.total} (${successRate}%)`);
    });
    
    // Individual test results
    log.info('\n🏃 INDIVIDUAL TEST RESULTS:');
    log.info('-'.repeat(40));
    
    this.performanceTests.forEach((test, index) => {
      const result = this.testResults[test.name];
      const status = result?.success ? '✅ PASS' : '❌ FAIL';
      const duration = result?.duration ? `(${result.duration}ms)` : '';
      
      log.info(`${index + 1}. ${test.name}: ${status} ${duration}`);
      log.info(`   Category: ${test.category}`);
      
      if (!result?.success && result?.error) {
        log.info(`   Error: ${result.error}`);
      }
    });
    
    // Performance requirements coverage
    log.info('\n📋 PERFORMANCE REQUIREMENTS COVERAGE:');
    log.info('-'.repeat(40));
    
    const allRequirements = new Set();
    const passedRequirements = new Set();
    
    this.performanceTests.forEach(test => {
      const result = this.testResults[test.name];
      test.requirements.forEach(req => {
        allRequirements.add(req);
        if (result?.success) {
          passedRequirements.add(req);
        }
      });
    });
    
    const sortedRequirements = Array.from(allRequirements).sort();
    
    sortedRequirements.forEach(req => {
      const status = passedRequirements.has(req) ? '✅' : '❌';
      log.info(`  ${status} Requirement ${req}`);
    });
    
    log.info(`\nRequirements Coverage: ${passedRequirements.size}/${allRequirements.size} (${Math.round(passedRequirements.size / allRequirements.size * 100)}%)`);
    
    // Performance assessment
    log.info('\n🎯 PERFORMANCE ASSESSMENT:');
    log.info('-'.repeat(40));
    
    if (totalFailed === 0) {
      log.info('🎉 ALL PERFORMANCE TESTS PASSED!');
      log.info('');
      log.info('✅ System meets all performance targets');
      log.info('✅ Load handling capabilities validated');
      log.info('✅ Concurrency and fairness verified');
      log.info('✅ Cache performance optimized');
      log.info('✅ System ready for high-load production use');
      log.info('');
      log.info('🚀 PERFORMANCE READINESS: ✅ EXCELLENT');
      
    } else if (totalFailed <= 1) {
      log.warn('⚠️  MOSTLY GOOD PERFORMANCE WITH MINOR ISSUES');
      log.warn('');
      log.warn('✅ Core performance is acceptable');
      log.warn('⚠️  Some optimization opportunities exist');
      log.warn('');
      log.warn('🔧 RECOMMENDED ACTIONS:');
      
      this.performanceTests.forEach(test => {
        const result = this.testResults[test.name];
        if (!result?.success) {
          log.warn(`   - Optimize: ${test.name} - ${result?.error || 'Performance issue'}`);
        }
      });
      
      log.warn('');
      log.warn('🚀 PERFORMANCE READINESS: ⚠️  GOOD (minor optimizations needed)');
      
    } else {
      log.error('❌ SIGNIFICANT PERFORMANCE ISSUES DETECTED');
      log.error('');
      log.error('❌ System performance below acceptable levels');
      log.error(`❌ ${totalFailed} critical performance tests failed`);
      log.error('');
      log.error('🔧 CRITICAL ACTIONS REQUIRED:');
      
      this.performanceTests.forEach(test => {
        const result = this.testResults[test.name];
        if (!result?.success) {
          log.error(`   - CRITICAL: Fix ${test.name}`);
          log.error(`     Category: ${test.category}`);
          log.error(`     Requirements: ${test.requirements.join(', ')}`);
          log.error(`     Issue: ${result?.error || 'Performance failure'}`);
        }
      });
      
      log.error('');
      log.error('🚀 PERFORMANCE READINESS: ❌ POOR (major issues must be resolved)');
    }
    
    // Performance recommendations
    log.info('\n💡 PERFORMANCE OPTIMIZATION RECOMMENDATIONS:');
    log.info('-'.repeat(40));
    
    if (totalPassed === this.performanceTests.length) {
      log.info('✅ System performance is optimal');
      log.info('✅ Consider monitoring these metrics in production:');
      log.info('   - Throughput (credentials/minute)');
      log.info('   - Cache hit rates (>60%)');
      log.info('   - Queue depth (<1000 tasks)');
      log.info('   - Worker utilization');
      log.info('   - Proxy distribution fairness');
    } else {
      log.info('🔧 Focus on these areas for improvement:');
      
      // Category-specific recommendations
      Object.entries(categoryResults).forEach(([category, results]) => {
        if (results.failed > 0) {
          switch (category) {
            case 'Load Testing':
              log.info('   - Scale worker instances for higher throughput');
              log.info('   - Optimize task processing pipeline');
              break;
            case 'Concurrency Testing':
              log.info('   - Review task distribution algorithms');
              log.info('   - Check for resource contention issues');
              break;
            case 'Cache Performance':
              log.info('   - Tune cache TTL settings');
              log.info('   - Optimize cache key generation');
              break;
            case 'Load Balancing':
              log.info('   - Review proxy assignment logic');
              log.info('   - Check proxy health monitoring');
              break;
          }
        }
      });
    }
    
    log.info('\n' + '='.repeat(80));
  }

  getResults() {
    return this.testResults;
  }
}

// Export for use as module
module.exports = PerformanceTestRunner;

// If run directly, execute performance tests
if (require.main === module) {
  const runner = new PerformanceTestRunner();
  
  runner.runPerformanceTests()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      log.error('Performance test runner failed', { error: error.message });
      process.exit(1);
    });
}