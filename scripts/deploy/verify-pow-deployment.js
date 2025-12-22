/**
 * =============================================================================
 * POW DEPLOYMENT VERIFICATION SCRIPT
 * =============================================================================
 * 
 * Simple script to verify POW service integration in Railway deployment.
 * Can be run as a health check or manual verification.
 * 
 * Usage:
 *   node scripts/verify-pow-deployment.js
 *   
 * Environment Variables:
 *   POW_SERVICE_URL - URL of the POW service (optional, defaults to localhost)
 * =============================================================================
 */

const { createLogger } = require('../logger');
const powServiceClient = require('../automation/http/fingerprinting/powServiceClient');

const log = createLogger('pow-deployment-verify');

async function verifyDeployment() {
  log.info('Verifying POW service deployment...');
  
  const serviceUrl = process.env.POW_SERVICE_URL || 'http://localhost:3001';
  log.info(`Testing POW service at: ${serviceUrl}`);
  
  try {
    // Test 1: Basic connection
    log.info('1. Testing service connection...');
    const isConnected = await powServiceClient.testConnection();
    
    if (isConnected) {
      log.info('✅ POW service is reachable');
    } else {
      log.warn('⚠️  POW service is not reachable - fallback mode will be used');
    }
    
    // Test 2: Basic computation
    log.info('2. Testing POW computation...');
    const testParams = {
      mask: '0000',
      key: 'deploy_test',
      seed: Date.now() % 1000000
    };
    
    const startTime = Date.now();
    const cres = await powServiceClient.computeCres(testParams);
    const computeTime = Date.now() - startTime;
    
    if (cres && cres.length === 16) {
      log.info(`✅ POW computation successful: ${cres} (${computeTime}ms)`);
    } else {
      log.error('❌ POW computation failed or returned invalid result');
      return false;
    }
    
    // Test 3: Check client statistics
    log.info('3. Checking client statistics...');
    const stats = powServiceClient.getStats();
    
    log.info('POW Client Statistics:', {
      serviceUrl: stats.service.url,
      successRate: stats.requests.successRate,
      fallbackRate: stats.fallback.rate,
      localCacheHitRate: stats.localCache.hitRate
    });
    
    // Test 4: Verify fallback works
    log.info('4. Testing fallback behavior...');
    const { POWServiceClient } = require('../automation/http/fingerprinting/powServiceClient');
    const fallbackClient = new POWServiceClient({
      serviceUrl: 'http://invalid-url:9999',
      timeout: 1000
    });
    
    const fallbackCres = await fallbackClient.computeCres({
      mask: '0001',
      key: 'fallback_test',
      seed: 12345
    });
    
    if (fallbackCres && fallbackCres.length === 16) {
      log.info(`✅ Fallback computation works: ${fallbackCres}`);
    } else {
      log.error('❌ Fallback computation failed');
      return false;
    }
    
    log.info('🎉 POW service deployment verification completed successfully!');
    
    // Print deployment recommendations
    if (isConnected) {
      log.info('📋 Deployment Status: POW service is operational');
      log.info('💡 Recommendation: Monitor cache hit rates and response times');
    } else {
      log.warn('📋 Deployment Status: POW service unavailable, using fallback mode');
      log.warn('💡 Recommendation: Check POW service deployment and network connectivity');
    }
    
    return true;
    
  } catch (error) {
    log.error('❌ Deployment verification failed:', error.message);
    log.error('🔧 Troubleshooting tips:');
    log.error('   - Check POW_SERVICE_URL environment variable');
    log.error('   - Verify POW service is running and accessible');
    log.error('   - Check network connectivity between services');
    log.error('   - Review POW service logs for errors');
    
    return false;
  }
}

// Run verification if called directly
if (require.main === module) {
  verifyDeployment()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((error) => {
      log.error('Verification script error:', error.message);
      process.exit(1);
    });
}

module.exports = { verifyDeployment };