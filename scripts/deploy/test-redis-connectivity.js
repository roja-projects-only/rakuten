#!/usr/bin/env node

/**
 * Redis Connectivity Test for Deployment
 * Simplified version of the timeout test for deployment verification
 */

const { initRedisClient } = require('../../src/shared/redis/client');
const { createLogger } = require('../../src/shared/logger');

const log = createLogger('redis-deploy-test');

async function testRedisForDeployment() {
  console.log('🔍 Testing Redis connectivity for deployment...\n');
  
  try {
    // Initialize Redis client
    const redis = await initRedisClient();
    
    console.log('✅ Redis connected successfully');
    console.log(`📊 Command timeout: ${process.env.REDIS_COMMAND_TIMEOUT || '60000'}ms`);
    
    // Quick ping test
    const pingResult = await redis.executeCommand('ping');
    console.log(`✅ PING: ${pingResult}`);
    
    // Test basic operations
    await redis.executeCommand('set', 'deploy:test', 'ok', 'EX', 10);
    const testValue = await redis.executeCommand('get', 'deploy:test');
    console.log(`✅ SET/GET: ${testValue}`);
    
    // Cleanup
    await redis.executeCommand('del', 'deploy:test');
    await redis.close();
    
    console.log('\n🎉 Redis connectivity test passed!');
    process.exit(0);
    
  } catch (error) {
    console.error('\n❌ Redis connectivity test failed:');
    console.error(`   Error: ${error.message}`);
    
    if (error.message.includes('Command timed out')) {
      console.error('\n🔧 Timeout detected - check REDIS_COMMAND_TIMEOUT configuration');
    }
    
    if (error.message.includes('ECONNREFUSED')) {
      console.error('\n🔧 Connection refused - check Redis server and REDIS_URL');
    }
    
    process.exit(1);
  }
}

// Run the test
if (require.main === module) {
  testRedisForDeployment().catch(console.error);
}

module.exports = { testRedisForDeployment };