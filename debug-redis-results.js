#!/usr/bin/env node

/**
 * Debug utility to check Redis result cache
 * Usage: node debug-redis-results.js [username:password]
 */

const { getRedisClient } = require('./shared/redis/client');
const { RESULT_CACHE } = require('./shared/redis/keys');
const { createLogger } = require('./logger');

const log = createLogger('debug-redis');

async function checkRedisResults(credentialKey = null) {
  const redis = getRedisClient();
  
  try {
    await redis.connect();
    
    if (credentialKey) {
      // Check specific credential
      const [username, password] = credentialKey.split(':');
      const statuses = ['VALID', 'INVALID', 'BLOCKED', 'ERROR'];
      
      console.log(`\nChecking credential: ${username}:${password}`);
      console.log('='.repeat(50));
      
      for (const status of statuses) {
        const key = RESULT_CACHE.generate(status, username, password);
        const result = await redis.executeCommand('get', key);
        
        if (result) {
          const data = JSON.parse(result);
          console.log(`✓ ${status}: ${key}`);
          console.log(`  Stored: ${new Date(data.timestamp).toISOString()}`);
          console.log(`  Data: ${JSON.stringify(data, null, 2)}`);
        } else {
          console.log(`✗ ${status}: ${key} (not found)`);
        }
      }
    } else {
      // Scan for all result keys
      console.log('\nScanning all result keys...');
      console.log('='.repeat(50));
      
      const keys = await redis.executeCommand('keys', 'result:*');
      console.log(`Found ${keys.length} result keys in Redis`);
      
      if (keys.length > 0) {
        console.log('\nFirst 10 keys:');
        for (let i = 0; i < Math.min(10, keys.length); i++) {
          const key = keys[i];
          const result = await redis.executeCommand('get', key);
          if (result) {
            const data = JSON.parse(result);
            console.log(`${i + 1}. ${key}`);
            console.log(`   Status: ${data.status}, User: ${data.username}, Time: ${new Date(data.timestamp).toISOString()}`);
          }
        }
        
        if (keys.length > 10) {
          console.log(`... and ${keys.length - 10} more keys`);
        }
      }
      
      // Show key distribution by status
      const statusCounts = { VALID: 0, INVALID: 0, BLOCKED: 0, ERROR: 0 };
      for (const key of keys) {
        const parts = key.split(':');
        if (parts.length >= 2) {
          const status = parts[1];
          if (statusCounts.hasOwnProperty(status)) {
            statusCounts[status]++;
          }
        }
      }
      
      console.log('\nResult distribution:');
      for (const [status, count] of Object.entries(statusCounts)) {
        console.log(`  ${status}: ${count}`);
      }
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await redis.close();
  }
}

// Parse command line arguments
const credentialKey = process.argv[2];

checkRedisResults(credentialKey).catch(console.error);