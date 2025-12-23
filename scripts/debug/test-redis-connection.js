#!/usr/bin/env node

/**
 * Test Redis connection with current configuration
 */

const { getRedisClient } = require('./shared/redis/client');
const { createLogger } = require('./logger');

const log = createLogger('redis-test');

async function testRedisConnection() {
  const redis = getRedisClient();
  
  console.log('Testing Redis connection...');
  console.log('REDIS_URL:', process.env.REDIS_URL || 'Not set');
  console.log('');
  
  try {
    console.log('1. Attempting to connect...');
    await redis.connect();
    console.log('✓ Connected successfully');
    
    console.log('2. Testing PING command...');
    const pingResult = await redis.executeCommand('ping');
    console.log('✓ PING result:', pingResult);
    
    console.log('3. Testing SET/GET commands...');
    await redis.executeCommand('set', 'test:connection', 'success');
    const getResult = await redis.executeCommand('get', 'test:connection');
    await redis.executeCommand('del', 'test:connection');
    console.log('✓ SET/GET test:', getResult);
    
    console.log('4. Testing key scanning...');
    const keys = await redis.executeCommand('keys', '*');
    console.log('✓ Total keys in Redis:', keys.length);
    
    if (keys.length > 0) {
      console.log('   Sample keys:', keys.slice(0, 5));
    }
    
    console.log('');
    console.log('🎉 Redis connection is working properly!');
    console.log('   The coordinator should be able to use distributed mode.');
    
  } catch (error) {
    console.log('');
    console.log('❌ Redis connection failed:', error.message);
    console.log('');
    console.log('This explains why the coordinator falls back to single-node mode.');
    console.log('Possible solutions:');
    console.log('1. Check if Railway Redis instance is accessible from your EC2');
    console.log('2. Verify Redis credentials are correct');
    console.log('3. Set up a Redis instance on your EC2 infrastructure');
    console.log('4. Use AWS ElastiCache Redis instead');
    
  } finally {
    await redis.close();
  }
}

testRedisConnection().catch(console.error);