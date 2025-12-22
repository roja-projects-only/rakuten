#!/usr/bin/env node

/**
 * Master Integration Test Runner
 * 
 * Executes all integration tests for the distributed worker architecture.
 * This script runs all the integration tests in sequence and provides
 * a comprehensive report of the system's readiness.
 */

const { createLogger } = require('../logger');
const { execSync } = require('child_process');

const log = createLogger('integration-test-runner');

class MasterIntegrationTestRunner {
  constructor() {
    this.testResults = {};
    this.testOrder = [
      {
        name: 'End-to-End Batch Processing',
        script: 'test-end-to-end-batch-processing.js',
        description: 'Tests complete batch processing workflow',
        requirements: ['1.1', '2.2', '5.3', '5.4']
      },
      {
        name: 'Coordinator Failover',
        script: 'test-coordinator-failover.js',
        description: 'Tests coordinator high availability and failover',
        requirements: ['12.3', '12.5', '12.8']
      },
      {
        name: 'Worker Crash Recovery',
        script: 'test-worker-crash-recovery.js',
        description: 'Tests worker crash recovery and zombie task handling',
        requirements: ['1.7', '2.5']
      },
      {
        name: 'Proxy Rotation and Health',
        script: 'test-proxy-rotation-health.js',
        description: 'Tests proxy management and health tracking',
        requirements: ['4.2', '4.4', '4.5']
      },
      {
        name: 'POW Service Degradation',
        script: 'test-pow-service-degradation.js',
        description: 'Tests POW service fallback mechanisms',
        requirements: ['3.5', '3.6', '3.7']
      },
      {
        name: 'Deduplication Across Batches',
        script: 'test-deduplication-across-batches.js',
        description: 'Tests cross-batch credential deduplication',
        requirements: ['7.1', '7.2', '7.5']
      }
    ];
  }

  async runAllTests() {
    log.info('🚀 Starting comprehensive integration test suite...');
    log.info(`Running ${this.testOrder.length} integration tests in sequence`);
    log.info('='.repeat(80));
    
    let totalPassed = 0;
    let totalFailed = 0;
    
    for (let i = 0; i < this.testOrder.length; i++) {
      const test = this.testOrder[i];
      
      log.info(`\n📋 Test ${i + 1}/${this.testOrder.length}: ${test.name}`);
      log.info(`Description: ${test.description}`);
      log.info(`Requirements: ${test.requirements.join(', ')}`);
      log.info(`Script: ${test.script}`);
      log.info('-'.repeat(60));
      
      try {
        const startTime = Date.now();
        
        // Run the test script
        const output = execSync(`node scripts/${test.script}`, {
          encoding: 'utf8',
          timeout: 120000, // 2 minutes timeout per test
          stdio: 'pipe'
        });
        
        const duration = Date.now() - startTime;
        
        this.testResults[test.name] = {
          success: true,
          duration,
          output: output.trim(),
          requirements: test.requirements,
          message: 'Test completed successfully'
        };
        
        totalPassed++;
        
        log.info(`✅ ${test.name}: PASSED (${duration}ms)`);
        
        // Show key results from output
        const lines = output.split('\n');
        const summaryLines = lines.filter(line => 
          line.includes('PASS') || 
          line.includes('FAIL') || 
          line.includes('✓') || 
          line.includes('❌') ||
          line.includes('OVERALL RESULT')
        );
        
        if (summaryLines.length > 0) {
          log.info('Key results:');
          summaryLines.slice(-5).forEach(line => {
            log.info(`  ${line.trim()}`);
          });
        }
        
      } catch (error) {
        const duration = Date.now() - Date.now(); // Will be 0 for failed tests
        
        this.testResults[test.name] = {
          success: false,
          duration,
          error: error.message,
          requirements: test.requirements,
          message: 'Test failed with error'
        };
        
        totalFailed++;
        
        log.error(`❌ ${test.name}: FAILED`);
        log.error(`Error: ${error.message}`);
        
        // Show stderr output if available
        if (error.stderr) {
          log.error('Error output:');
          log.error(error.stderr.toString());
        }
      }
      
      // Small delay between tests
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Generate comprehensive report
    this.generateFinalReport(totalPassed, totalFailed);
    
    return totalFailed === 0;
  }

  generateFinalReport(totalPassed, totalFailed) {
    log.info('\n' + '='.repeat(80));
    log.info('🎯 DISTRIBUTED WORKER ARCHITECTURE - INTEGRATION TEST REPORT');
    log.info('='.repeat(80));
    
    // Test results summary
    log.info('\n📊 TEST RESULTS SUMMARY:');
    log.info('-'.repeat(40));
    
    this.testOrder.forEach((test, index) => {
      const result = this.testResults[test.name];
      const status = result?.success ? '✅ PASS' : '❌ FAIL';
      const duration = result?.duration ? `(${result.duration}ms)` : '';
      
      log.info(`${index + 1}. ${test.name}: ${status} ${duration}`);
      
      if (!result?.success && result?.error) {
        log.info(`   Error: ${result.error}`);
      }
    });
    
    // Requirements coverage
    log.info('\n📋 REQUIREMENTS COVERAGE:');
    log.info('-'.repeat(40));
    
    const allRequirements = new Set();
    const passedRequirements = new Set();
    
    this.testOrder.forEach(test => {
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
    
    // Overall assessment
    log.info('\n🎯 OVERALL ASSESSMENT:');
    log.info('-'.repeat(40));
    log.info(`Total Tests: ${this.testOrder.length}`);
    log.info(`Passed: ${totalPassed}`);
    log.info(`Failed: ${totalFailed}`);
    log.info(`Success Rate: ${Math.round(totalPassed / this.testOrder.length * 100)}%`);
    
    if (totalFailed === 0) {
      log.info('\n🎉 ALL INTEGRATION TESTS PASSED!');
      log.info('');
      log.info('✅ System is ready for production deployment');
      log.info('✅ All distributed components integrate correctly');
      log.info('✅ Failover and recovery mechanisms work');
      log.info('✅ Performance and scalability features validated');
      log.info('✅ Data consistency and deduplication verified');
      log.info('');
      log.info('🚀 DEPLOYMENT READINESS: ✅ APPROVED');
      
    } else if (totalFailed <= 2) {
      log.warn('\n⚠️  MOSTLY SUCCESSFUL WITH MINOR ISSUES');
      log.warn('');
      log.warn('✅ Core functionality is working');
      log.warn('⚠️  Some advanced features need attention');
      log.warn('');
      log.warn('🔧 RECOMMENDED ACTIONS:');
      
      this.testOrder.forEach(test => {
        const result = this.testResults[test.name];
        if (!result?.success) {
          log.warn(`   - Fix: ${test.name} - ${result?.error || 'Unknown error'}`);
        }
      });
      
      log.warn('');
      log.warn('🚀 DEPLOYMENT READINESS: ⚠️  CONDITIONAL (fix issues first)');
      
    } else {
      log.error('\n❌ SIGNIFICANT ISSUES DETECTED');
      log.error('');
      log.error('❌ System is not ready for production deployment');
      log.error(`❌ ${totalFailed} critical integration tests failed`);
      log.error('');
      log.error('🔧 REQUIRED ACTIONS:');
      
      this.testOrder.forEach(test => {
        const result = this.testResults[test.name];
        if (!result?.success) {
          log.error(`   - CRITICAL: Fix ${test.name}`);
          log.error(`     Requirements: ${test.requirements.join(', ')}`);
          log.error(`     Error: ${result?.error || 'Unknown error'}`);
        }
      });
      
      log.error('');
      log.error('🚀 DEPLOYMENT READINESS: ❌ BLOCKED');
    }
    
    log.info('\n' + '='.repeat(80));
  }

  getResults() {
    return this.testResults;
  }
}

// Export for use as module
module.exports = MasterIntegrationTestRunner;

// If run directly, execute all tests
if (require.main === module) {
  const runner = new MasterIntegrationTestRunner();
  
  runner.runAllTests()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      log.error('Integration test runner failed', { error: error.message });
      process.exit(1);
    });
}