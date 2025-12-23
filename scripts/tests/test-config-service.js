#!/usr/bin/env node

/**
 * Config Service Integration Test
 * 
 * Tests the centralized configuration system including:
 * - Schema validation
 * - Redis storage and retrieval
 * - Pub/sub propagation across instances
 * - Hot-reload without restart
 * - Env fallback behavior
 * 
 * Usage: node scripts/tests/test-config-service.js
 */

require('dotenv').config();
const { createLogger } = require('../../logger');
const { initRedisClient, getPubSubClient, closeRedisClient, closePubSubClient } = require('../../shared/redis/client');
const { initConfigService, getConfigService, CONFIG_CHANNEL } = require('../../shared/config/configService');
const { validateValue, getEnvDefault, getConfigKeys } = require('../../shared/config/configSchema');

const log = createLogger('config-test');

// Test utilities
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (!condition) {
    log.error(`❌ FAIL: ${message}`);
    testsFailed++;
    throw new Error(`Assertion failed: ${message}`);
  } else {
    log.info(`✅ PASS: ${message}`);
    testsPassed++;
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    log.error(`❌ FAIL: ${message}`);
    log.error(`   Expected: ${expected}`);
    log.error(`   Actual: ${actual}`);
    testsFailed++;
    throw new Error(`Assertion failed: ${message}`);
  } else {
    log.info(`✅ PASS: ${message}`);
    testsPassed++;
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Test suite
async function runTests() {
  log.info('═══════════════════════════════════════════════════════════');
  log.info('  Config Service Integration Test Suite');
  log.info('═══════════════════════════════════════════════════════════');
  
  let redisClient = null;
  let pubSubClient1 = null;
  let pubSubClient2 = null;
  let configService1 = null;
  let configService2 = null;
  
  try {
    // =========================================================================
    // TEST 1: Schema Validation
    // =========================================================================
    log.info('\n📋 TEST 1: Schema Validation');
    
    // Valid integer
    let result = validateValue('BATCH_CONCURRENCY', '5');
    assert(result.valid, 'Valid integer accepted');
    assertEquals(result.parsedValue, 5, 'Integer parsed correctly');
    
    // Invalid integer (out of range)
    result = validateValue('BATCH_CONCURRENCY', '100');
    assert(!result.valid, 'Out-of-range integer rejected');
    
    // Valid enum
    result = validateValue('LOG_LEVEL', 'debug');
    assert(result.valid, 'Valid enum accepted');
    assertEquals(result.parsedValue, 'debug', 'Enum value correct');
    
    // Invalid enum
    result = validateValue('LOG_LEVEL', 'invalid');
    assert(!result.valid, 'Invalid enum rejected');
    
    // Valid boolean
    result = validateValue('JSON_LOGGING', 'true');
    assert(result.valid, 'Boolean "true" accepted');
    assertEquals(result.parsedValue, true, 'Boolean parsed as true');
    
    result = validateValue('JSON_LOGGING', 'false');
    assert(result.valid, 'Boolean "false" accepted');
    assertEquals(result.parsedValue, false, 'Boolean parsed as false');
    
    // Valid URL
    result = validateValue('PROXY_SERVER', 'http://proxy:8080');
    assert(result.valid, 'Valid proxy URL accepted');
    
    // Empty allowed field
    result = validateValue('PROXY_SERVER', '');
    assert(result.valid, 'Empty value accepted for allowEmpty field');
    
    // Channel ID validation
    result = validateValue('FORWARD_CHANNEL_ID', '-1001234567890');
    assert(result.valid, 'Negative channel ID accepted');
    
    result = validateValue('FORWARD_CHANNEL_ID', '@channelname');
    assert(result.valid, 'Username channel ID accepted');
    
    log.info('✅ Schema validation tests passed');
    
    // =========================================================================
    // TEST 2: Redis Integration
    // =========================================================================
    log.info('\n🔴 TEST 2: Redis Integration');
    
    // Check Redis availability
    if (!process.env.REDIS_URL) {
      log.warn('⚠️  REDIS_URL not set - skipping Redis tests');
      log.warn('   Set REDIS_URL to run full integration tests');
      return;
    }
    
    // Initialize Redis clients
    log.info('Connecting to Redis...');
    redisClient = await initRedisClient();
    pubSubClient1 = getPubSubClient();
    await pubSubClient1.connect();
    
    // Initialize config service
    const { ConfigService } = require('../../shared/config/configService');
    configService1 = new ConfigService();
    await configService1.initialize(redisClient, pubSubClient1);
    
    assert(configService1.isInitialized(), 'Config service initialized');
    
    // Clean up any existing test config
    await redisClient.getClient().del('config:BATCH_CONCURRENCY');
    await sleep(100);
    
    // =========================================================================
    // TEST 3: Get/Set/Reset Operations
    // =========================================================================
    log.info('\n⚙️  TEST 3: Get/Set/Reset Operations');
    
    // Get default value
    let value = configService1.get('BATCH_CONCURRENCY');
    log.info(`Default BATCH_CONCURRENCY: ${value}`);
    
    // Set a value
    let setResult = await configService1.set('BATCH_CONCURRENCY', '10');
    assert(setResult.success, 'Set operation succeeded');
    assertEquals(setResult.value, 10, 'Set value correct');
    
    // Get the set value
    value = configService1.get('BATCH_CONCURRENCY');
    assertEquals(value, 10, 'Get returns set value');
    
    // Check source
    let withSource = configService1.getWithSource('BATCH_CONCURRENCY');
    assertEquals(withSource.source, 'redis', 'Source is redis after set');
    assertEquals(withSource.value, 10, 'Value from getWithSource correct');
    
    // Set invalid value
    setResult = await configService1.set('BATCH_CONCURRENCY', '100');
    assert(!setResult.success, 'Invalid value rejected');
    
    // Value should remain unchanged
    value = configService1.get('BATCH_CONCURRENCY');
    assertEquals(value, 10, 'Value unchanged after invalid set');
    
    // Reset to default
    let resetResult = await configService1.reset('BATCH_CONCURRENCY');
    assert(resetResult.success, 'Reset operation succeeded');
    
    value = configService1.get('BATCH_CONCURRENCY');
    const defaultValue = getEnvDefault('BATCH_CONCURRENCY');
    assertEquals(value, defaultValue, 'Value reset to default');
    
    withSource = configService1.getWithSource('BATCH_CONCURRENCY');
    assert(withSource.source !== 'redis', 'Source is not redis after reset');
    
    log.info('✅ Get/Set/Reset operations passed');
    
    // =========================================================================
    // TEST 4: List Operations
    // =========================================================================
    log.info('\n📜 TEST 4: List Operations');
    
    const list = configService1.list();
    assert(Array.isArray(list), 'List returns array');
    assert(list.length > 0, 'List has items');
    
    const keys = getConfigKeys();
    assertEquals(list.length, keys.length, 'List has all config keys');
    
    const firstItem = list[0];
    assert(firstItem.key, 'List item has key');
    assert(firstItem.value !== undefined, 'List item has value');
    assert(firstItem.source, 'List item has source');
    assert(firstItem.description, 'List item has description');
    assert(firstItem.category, 'List item has category');
    
    // Test category filtering
    const batchConfigs = configService1.listByCategory('batch');
    assert(batchConfigs.length > 0, 'Category filtering works');
    assert(batchConfigs.every(item => item.category === 'batch'), 'All items in category');
    
    log.info('✅ List operations passed');
    
    // =========================================================================
    // TEST 5: Pub/Sub Propagation
    // =========================================================================
    log.info('\n📡 TEST 5: Pub/Sub Propagation');
    
    // Create a second config service instance (simulating another worker/coordinator)
    const pubSubClient2Wrapper = getPubSubClient({ db: 0 });
    await pubSubClient2Wrapper.connect();
    
    configService2 = new ConfigService();
    await configService2.initialize(redisClient, pubSubClient2Wrapper);
    
    let updateReceived = false;
    let receivedKey = null;
    let receivedValue = null;
    
    // Subscribe to updates on instance 2
    await configService2.subscribe((key, value, action) => {
      log.info(`Instance 2 received update: ${key} = ${value} (${action})`);
      updateReceived = true;
      receivedKey = key;
      receivedValue = value;
    });
    
    // Give subscription time to establish
    await sleep(500);
    
    // Set value on instance 1
    log.info('Setting BATCH_CONCURRENCY=7 on instance 1...');
    await configService1.set('BATCH_CONCURRENCY', '7');
    
    // Wait for pub/sub propagation
    await sleep(500);
    
    assert(updateReceived, 'Update received via pub/sub');
    assertEquals(receivedKey, 'BATCH_CONCURRENCY', 'Correct key received');
    assertEquals(receivedValue, 7, 'Correct value received');
    
    // Check instance 2 has the updated value
    const instance2Value = configService2.get('BATCH_CONCURRENCY');
    assertEquals(instance2Value, 7, 'Instance 2 has updated value');
    
    // Test reset propagation
    updateReceived = false;
    log.info('Resetting BATCH_CONCURRENCY on instance 1...');
    await configService1.reset('BATCH_CONCURRENCY');
    
    await sleep(500);
    
    assert(updateReceived, 'Reset update received via pub/sub');
    
    // Both instances should have default value now
    const inst1Value = configService1.get('BATCH_CONCURRENCY');
    const inst2Value = configService2.get('BATCH_CONCURRENCY');
    assertEquals(inst1Value, inst2Value, 'Both instances have same value after reset');
    
    log.info('✅ Pub/Sub propagation passed');
    
    // =========================================================================
    // TEST 6: Multiple Config Updates
    // =========================================================================
    log.info('\n🔄 TEST 6: Multiple Config Updates');
    
    await configService1.set('BATCH_CONCURRENCY', '5');
    await configService1.set('BATCH_DELAY_MS', '100');
    await configService1.set('LOG_LEVEL', 'debug');
    await configService1.set('WORKER_CONCURRENCY', '10');
    
    await sleep(500);
    
    assertEquals(configService2.get('BATCH_CONCURRENCY'), 5, 'Instance 2 has BATCH_CONCURRENCY');
    assertEquals(configService2.get('BATCH_DELAY_MS'), 100, 'Instance 2 has BATCH_DELAY_MS');
    assertEquals(configService2.get('LOG_LEVEL'), 'debug', 'Instance 2 has LOG_LEVEL');
    assertEquals(configService2.get('WORKER_CONCURRENCY'), 10, 'Instance 2 has WORKER_CONCURRENCY');
    
    log.info('✅ Multiple config updates passed');
    
    // =========================================================================
    // TEST 7: Precedence (Redis > Env > Default)
    // =========================================================================
    log.info('\n🎯 TEST 7: Config Precedence');
    
    // Reset all test configs
    await configService1.reset('BATCH_CONCURRENCY');
    await sleep(100);
    
    // Check precedence: should be env or default (no redis value)
    withSource = configService1.getWithSource('BATCH_CONCURRENCY');
    assert(withSource.source === 'env' || withSource.source === 'default', 'Falls back to env/default when no redis');
    
    // Set in Redis
    await configService1.set('BATCH_CONCURRENCY', '15');
    await sleep(100);
    
    // Should now come from Redis
    withSource = configService1.getWithSource('BATCH_CONCURRENCY');
    assertEquals(withSource.source, 'redis', 'Redis takes precedence');
    assertEquals(withSource.value, 15, 'Redis value used');
    
    log.info('✅ Config precedence passed');
    
    // =========================================================================
    // Cleanup
    // =========================================================================
    log.info('\n🧹 Cleanup...');
    
    // Clean up test configs
    await redisClient.getClient().del('config:BATCH_CONCURRENCY');
    await redisClient.getClient().del('config:BATCH_DELAY_MS');
    await redisClient.getClient().del('config:LOG_LEVEL');
    await redisClient.getClient().del('config:WORKER_CONCURRENCY');
    
    await sleep(100);
    
  } catch (error) {
    log.error('Test failed with error:', error.message);
    log.error(error.stack);
    testsFailed++;
  } finally {
    // Close connections
    if (redisClient) {
      await redisClient.close();
    }
    if (pubSubClient1) {
      await pubSubClient1.close();
    }
    if (pubSubClient2) {
      await pubSubClient2.close();
    }
  }
  
  // =========================================================================
  // Summary
  // =========================================================================
  log.info('\n═══════════════════════════════════════════════════════════');
  log.info('  Test Summary');
  log.info('═══════════════════════════════════════════════════════════');
  log.info(`✅ Passed: ${testsPassed}`);
  log.info(`❌ Failed: ${testsFailed}`);
  log.info(`📊 Total:  ${testsPassed + testsFailed}`);
  
  if (testsFailed === 0) {
    log.info('\n🎉 All tests passed!');
    process.exit(0);
  } else {
    log.error('\n💥 Some tests failed');
    process.exit(1);
  }
}

// Run tests
if (require.main === module) {
  runTests().catch((error) => {
    log.error('Fatal test error:', error.message);
    log.error(error.stack);
    process.exit(1);
  });
}

module.exports = { runTests };
