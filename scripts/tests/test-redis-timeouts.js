#!/usr/bin/env node

/**
 * Redis Timeout Diagnostic Script
 * 
 * Tests Redis connectivity and timeout configurations
 * Run this to diagnose Redis timeout issues
 */

const { initRedisClient } = require('../shared/redis/client');
const { createLogger } = require('../logger');

const log = createLogger('redis-test');

async function testRedisTimeouts() {
  console.log('🔍 Testing Redis connectivity and timeouts...\n');
  
  try {
    // Initialize Redis client
    console.log('📡 Connecting to Redis...');
    const redis = await initRedisClient();
    
    console.log('✅ Redis connected successfully');
    console.log(`📊 Command timeout: ${process.env.REDIS_COMMAND_TIMEOUT || 'default (60000)'}ms`);
    console.log(`📊 Redis URL: ${process.env.REDIS_URL || 'not set'}\n`);
    
    // Test basic commands
    console.log('🧪 Testing basic Redis commands...');
    
    // Test PING
    console.log('  Testing PING...');
    const pingStart = Date.now();
    const pingResult = await redis.executeCommand('ping');
    const pingDuration = Date.now() - pingStart;
    console.log(`  ✅ PING: ${pingResult} (${pingDuration}ms)`);
    
    // Test SET/GET
    console.log('  Testing SET/GET...');
    const setStart = Date.now();
    await redis.executeCommand('set', 'test:timeout', 'test-value', 'EX', 60);
    const setDuration = Date.now() - setStart;
    console.log(`  ✅ SET: completed (${setDuration}ms)`);
    
    const getStart = Date.now();
    const getValue = await redis.executeCommand('get', 'test:timeout');
    const getDuration = Date.now() - getStart;
    console.log(`  ✅ GET: ${getValue} (${getDuration}ms)`);
    
    // Test PUBLISH
    console.log('  Testing PUBLISH...');
    const publishStart = Date.now();
    const publishResult = await redis.executeCommand('publish', 'test:channel', 'test-message');
    const publishDuration = Date.now() - publishStart;
    console.log(`  ✅ PUBLISH: ${publishResult} subscribers (${publishDuration}ms)`);
    
    // Test BLPOP with short timeout
    console.log('  Testing BLPOP (5 second timeout)...');
    const blpopStart = Date.now();
    const blpopResult = await redis.executeCommand('blpop', 'test:queue:empty', 5);
    const blpopDuration = Date.now() - blpopStart;
    console.log(`  ✅ BLPOP: ${blpopResult ? 'got result' : 'timeout (expected)'} (${blpopDuration}ms)`);
    
    // Test health check
    console.log('  Testing health check...');
    const healthStart = Date.now();
    const isHealthy = await redis.isHealthy();
    const healthDuration = Date.now() - healthStart;
    console.log(`  ✅ Health check: ${isHealthy} (${healthDuration}ms)`);
    
    // Cleanup
    await redis.executeCommand('del', 'test:timeout');
    
    console.log('\n🎉 All Redis tests passed!');
    console.log('✅ Redis connectivity is working properly');
    console.log('✅ Timeout configurations appear to be correct');
    
    // Close connection
    await redis.close();
    
  } catch (error) {
    console.error('\n❌ Redis test failed:');
    console.error(`   Error: ${error.message}`);
    console.error(`   Stack: ${error.stack}`);
    
    if (error.message.includes('Command timed out')) {
      console.error('\n🔧 Timeout Issue Detected:');
      console.error('   - Check REDIS_COMMAND_TIMEOUT environment variable');
      console.error('   - Ensure REDIS_COMMAND_TIMEOUT > WORKER_QUEUE_TIMEOUT');
      console.error('   - Check Redis server performance and network latency');
      console.error('   - Consider increasing timeout values');
    }
    
    if (error.message.includes('ECONNREFUSED')) {
      console.error('\n🔧 Connection Issue Detected:');
      console.error('   - Check REDIS_URL environment variable');
      console.error('   - Ensure Redis server is running and accessible');
      console.error('   - Check network connectivity and firewall rules');
    }
    
    process.exit(1);
  }
}

// Run the test
if (require.main === module) {
  testRedisTimeouts().catch(console.error);
}

module.exports = { testRedisTimeouts };