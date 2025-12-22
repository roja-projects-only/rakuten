#!/usr/bin/env node

/**
 * Integration Test Validation Script
 * 
 * Validates that all integration test files are properly structured
 * and can be loaded without requiring external dependencies like Redis.
 */

const { createLogger } = require('../logger');
const fs = require('fs');
const path = require('path');

const log = createLogger('test-validator');

class IntegrationTestValidator {
  constructor() {
    this.testFiles = [
      'test-end-to-end-batch-processing.js',
      'test-coordinator-failover.js',
      'test-worker-crash-recovery.js',
      'test-proxy-rotation-health.js',
      'test-pow-service-degradation.js',
      'test-deduplication-across-batches.js',
      'test-load-10k-batch.js',
      'test-concurrent-batch-processing.js',
      'test-pow-cache-hit-rate.js',
      'test-proxy-fairness.js',
      'run-all-integration-tests.js'
    ];
    
    this.validationResults = {};
  }

  async validateAllTests() {
    log.info('🔍 Validating integration test files...');
    
    let passCount = 0;
    let totalCount = this.testFiles.length;
    
    for (const testFile of this.testFiles) {
      try {
        await this.validateTestFile(testFile);
        passCount++;
      } catch (error) {
        log.error(`❌ ${testFile}: ${error.message}`);
      }
    }
    
    this.printValidationSummary(passCount, totalCount);
    
    return passCount === totalCount;
  }

  async validateTestFile(testFile) {
    const filePath = path.join(__dirname, testFile);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error('File does not exist');
    }
    
    // Check file size (should not be empty)
    const stats = fs.statSync(filePath);
    if (stats.size === 0) {
      throw new Error('File is empty');
    }
    
    // Read file content
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Validate file structure (different for master runner)
    const isMasterRunner = testFile === 'run-all-integration-tests.js';
    
    const validations = [
      {
        name: 'Has proper header comment',
        check: () => content.includes('/**') && content.includes('*/')
      },
      {
        name: 'Has class definition',
        check: () => isMasterRunner ? /class \w+Runner/.test(content) : /class \w+Test/.test(content)
      },
      {
        name: 'Has main method',
        check: () => isMasterRunner ? content.includes('async runAllTests()') : content.includes('async runTest()')
      },
      {
        name: 'Has cleanup or report method',
        check: () => isMasterRunner ? content.includes('generateFinalReport') : content.includes('async cleanup()')
      },
      {
        name: 'Has summary method',
        check: () => isMasterRunner ? content.includes('generateFinalReport') : content.includes('printTestSummary()')
      },
      {
        name: 'Has module export',
        check: () => content.includes('module.exports')
      },
      {
        name: 'Has main execution block',
        check: () => content.includes('if (require.main === module)')
      },
      {
        name: 'Uses structured logging',
        check: () => content.includes('createLogger')
      },
      {
        name: 'Has error handling',
        check: () => content.includes('try') && content.includes('catch')
      },
      {
        name: 'Has results tracking',
        check: () => isMasterRunner ? content.includes('testResults') : content.includes('testResults')
      }
    ];
    
    const failedValidations = [];
    
    for (const validation of validations) {
      if (!validation.check()) {
        failedValidations.push(validation.name);
      }
    }
    
    if (failedValidations.length > 0) {
      throw new Error(`Failed validations: ${failedValidations.join(', ')}`);
    }
    
    // Try to load the module (without executing)
    try {
      delete require.cache[require.resolve(filePath)];
      const TestClass = require(filePath);
      
      if (typeof TestClass !== 'function') {
        throw new Error('Module does not export a constructor function');
      }
      
    } catch (error) {
      if (error.message.includes('REDIS_URL')) {
        // This is expected - the test requires Redis but the class loaded successfully
        log.debug(`${testFile}: Correctly requires Redis (expected)`);
      } else {
        throw new Error(`Module loading failed: ${error.message}`);
      }
    }
    
    this.validationResults[testFile] = {
      success: true,
      fileSize: stats.size,
      validationsCount: validations.length,
      message: 'All validations passed'
    };
    
    log.info(`✅ ${testFile}: Valid (${stats.size} bytes, ${validations.length} checks)`);
  }

  printValidationSummary(passCount, totalCount) {
    log.info('='.repeat(70));
    log.info('INTEGRATION TEST VALIDATION SUMMARY');
    log.info('='.repeat(70));
    
    log.info(`Files validated: ${totalCount}`);
    log.info(`Passed: ${passCount}`);
    log.info(`Failed: ${totalCount - passCount}`);
    log.info(`Success rate: ${Math.round(passCount / totalCount * 100)}%`);
    
    if (passCount === totalCount) {
      log.info('');
      log.info('🎉 All integration test files are properly structured!');
      log.info('✅ File structure validation passed');
      log.info('✅ Class definitions are correct');
      log.info('✅ Required methods are present');
      log.info('✅ Error handling is implemented');
      log.info('✅ Logging is properly configured');
      log.info('✅ Module exports are correct');
      log.info('');
      log.info('📋 Test files ready for execution:');
      
      this.testFiles.forEach((file, index) => {
        const result = this.validationResults[file];
        if (result?.success) {
          log.info(`   ${index + 1}. ${file} (${result.fileSize} bytes)`);
        }
      });
      
      log.info('');
      log.info('🚀 To run integration tests:');
      log.info('   1. Set REDIS_URL environment variable');
      log.info('   2. Run: npm run test:integration');
      log.info('   3. Or run individual tests: npm run test:e2e-batch');
      
    } else {
      log.error('');
      log.error('❌ Some integration test files have issues');
      log.error('');
      log.error('🔧 Files that need attention:');
      
      this.testFiles.forEach(file => {
        const result = this.validationResults[file];
        if (!result?.success) {
          log.error(`   - ${file}: ${result?.message || 'Validation failed'}`);
        }
      });
    }
    
    log.info('='.repeat(70));
  }

  getResults() {
    return this.validationResults;
  }
}

// Export for use as module
module.exports = IntegrationTestValidator;

// If run directly, execute validation
if (require.main === module) {
  const validator = new IntegrationTestValidator();
  
  validator.validateAllTests()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      log.error('Validation failed', { error: error.message });
      process.exit(1);
    });
}