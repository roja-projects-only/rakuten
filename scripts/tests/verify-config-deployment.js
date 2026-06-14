#!/usr/bin/env node

/**
 * Config Service Deployment Verification
 * 
 * Quick smoke test to verify config service is working on deployed instances.
 * Can be run via Railway run command or SSH into AWS EC2 instances.
 * 
 * Usage: 
 *   Local: node scripts/tests/verify-config-deployment.js
 *   Railway: railway run node scripts/tests/verify-config-deployment.js
 *   SSH: ssh user@instance "cd app && node scripts/tests/verify-config-deployment.js"
 */

require('dotenv').config();
const { createLogger } = require('../../src/shared/logger');

const log = createLogger('config-verify');

async function verify() {
  log.info('═══════════════════════════════════════════════════════════');
  log.info('  Config Service Deployment Verification');
  log.info('═══════════════════════════════════════════════════════════');
  
  try {
    // Check 1: Required modules load
    log.info('\n📦 Checking modules...');
    const { getConfigService } = require('../../src/shared/config/configService');
    const { getConfigKeys } = require('../../src/shared/config/configSchema');
    log.info('✅ Config modules loaded');
    
    // Check 2: Schema is valid
    log.info('\n📋 Checking schema...');
    const keys = getConfigKeys();
    log.info(`✅ Schema has ${keys.length} configurable keys`);
    log.info(`   Keys: ${keys.join(', ')}`);
    
    // Check 3: ConfigService singleton
    log.info('\n⚙️  Checking config service...');
    const configService = getConfigService();
    
    if (!configService.isInitialized()) {
      log.warn('⚠️  Config service not initialized (no Redis?)');
      log.warn('   This is OK for single-node mode');
      log.warn('   For distributed mode, ensure REDIS_URL is set');
    } else {
      log.info('✅ Config service initialized');
    }
    
    // Check 4: Can read values (env fallback should work even without Redis)
    log.info('\n🔍 Checking config values...');
    const testKeys = [
      'BATCH_CONCURRENCY',
      'BATCH_DELAY_MS',
      'LOG_LEVEL',
      'WORKER_CONCURRENCY',
      'FORWARD_CHANNEL_ID'
    ];
    
    for (const key of testKeys) {
      const value = configService.get(key);
      const { source } = configService.getWithSource(key);
      log.info(`   ${key}: ${value} (from ${source})`);
    }
    
    log.info('✅ Config values readable');
    
    // Check 5: List operation
    log.info('\n📜 Checking list operation...');
    const list = configService.list();
    log.info(`✅ List returned ${list.length} items`);
    
    const sources = {
      redis: list.filter(i => i.source === 'redis').length,
      env: list.filter(i => i.source === 'env').length,
      default: list.filter(i => i.source === 'default').length
    };
    log.info(`   Sources: ${sources.redis} redis, ${sources.env} env, ${sources.default} default`);
    
    // Check 6: Environment check
    log.info('\n🌍 Environment check...');
    log.info(`   NODE_ENV: ${process.env.NODE_ENV || 'not set'}`);
    log.info(`   REDIS_URL: ${process.env.REDIS_URL ? 'configured' : 'not set'}`);
    log.info(`   Mode: coordinator (always — each service has its own entrypoint)`);
    
    // Summary
    log.info('\n═══════════════════════════════════════════════════════════');
    log.info('  ✅ Verification Complete');
    log.info('═══════════════════════════════════════════════════════════');
    
    if (configService.isInitialized()) {
      log.info('\n💡 Config service is ready!');
      log.info('   You can now use /config commands in Telegram');
      log.info('   Changes will propagate to all instances');
    } else {
      log.info('\n💡 Config service in fallback mode');
      log.info('   Using environment variables only');
      log.info('   Set REDIS_URL for centralized config');
    }
    
    process.exit(0);
    
  } catch (error) {
    log.error('\n❌ Verification failed:', error.message);
    log.error(error.stack);
    process.exit(1);
  }
}

// Run verification
if (require.main === module) {
  verify().catch((error) => {
    log.error('Fatal verification error:', error.message);
    process.exit(1);
  });
}

module.exports = { verify };
