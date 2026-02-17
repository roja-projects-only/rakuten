/**
 * =============================================================================
 * RAKUTEN TELEGRAM BOT - MAIN ENTRY POINT
 * =============================================================================
 * 
 * High-speed HTTP-based Rakuten credential checker bot.
 * 
 * Environment Variables Required:
 *   - TELEGRAM_BOT_TOKEN: Bot token from @BotFather
 *   - TARGET_LOGIN_URL: Rakuten login URL
 * 
 * Optional Environment Variables:
 *   - TIMEOUT_MS: Operation timeout (default: 60000)
 *   - PROXY_SERVER: Proxy URL for requests
 *   - BATCH_CONCURRENCY: Parallel batch checks (default: 1)
 * 
 * =============================================================================
 */

require('dotenv').config();
const { createCompatibilityLayer } = require('./shared/compatibility');
const { initializeTelegramHandler } = require('./telegramHandler');
const { getAllActiveBatches, waitForAllBatchCompletion } = require('./telegram/batchHandlers');
const { getAllActiveCombineBatches, waitForAllCombineBatchCompletion } = require('./telegram/combineBatchRunner');
const { flushWriteBuffer, closeStore } = require('./automation/batch/processedStore');
const { initConfigService, getConfigService } = require('./shared/config/configService');
const { getRedisClient, getPubSubClient } = require('./shared/redis/client');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const log = createLogger('main');

/**
 * Validates required environment variables based on deployment mode.
 * @throws {Error} If any required variable is missing
 */
function validateEnvironment() {
  // Use compatibility layer for validation
  try {
    const { validateEnvironment } = require('./shared/config/environment');
    const { config, mode, warnings } = validateEnvironment('auto');
    
    log.info(`Detected deployment mode: ${mode}`);
    
    if (warnings.length > 0) {
      warnings.forEach(warning => log.warn(warning));
    }
    
    // Check for required variables based on mode
    if (mode === 'single') {
      const required = ['TELEGRAM_BOT_TOKEN', 'TARGET_LOGIN_URL'];
      const missing = required.filter(key => !process.env[key]);
      
      if (missing.length > 0) {
        throw new Error(
          `❌ Missing required environment variables for single-node mode: ${missing.join(', ')}\n\n` +
          '📝 Please create a .env file with:\n' +
          '   TELEGRAM_BOT_TOKEN=your_token_here\n' +
          '   TARGET_LOGIN_URL=https://login.account.rakuten.com/...\n\n' +
          '💡 Copy .env.example to .env and fill in your values.'
        );
      }
    }
    
    log.success('Environment variables validated.');
    return { config, mode };
    
  } catch (error) {
    throw new Error(`Environment validation failed: ${error.message}`);
  }
}

/**
 * Ensures required directories exist.
 */
function ensureDirectories() {
  // No directories needed for HTTP-based checker
}

/**
 * Display startup banner.
 */
function displayBanner() {
  console.clear();
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║                                                           ║');
  console.log('║        🎌  RAKUTEN CREDENTIAL CHECKER BOT  🎌            ║');
  console.log('║                                                           ║');
  console.log('║           Automated Account Verification System           ║');
  console.log('║                                                           ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');
}

/**
 * Main bot initialization and startup.
 */
async function main() {
  try {
    displayBanner();
    log.info('Starting bot initialization...');

    // Validate environment and detect mode
    const { config, mode } = validateEnvironment();

    // Ensure directories
    ensureDirectories();

    // Initialize compatibility layer
    log.info('Initializing compatibility layer...');
    const compatibility = await createCompatibilityLayer();
    
    log.info(`Running in ${compatibility.getMode()} mode`);
    
    // Initialize centralized config service (always attempt; falls back to env on failure)
    try {
      log.info('Initializing centralized config service...');
      const redisClient = getRedisClient();
      await redisClient.connect();
      
      // Pub/sub client for subscribing to config updates
      const pubSubClient = getPubSubClient();
      await pubSubClient.connect();
      
      await initConfigService(redisClient, pubSubClient);
      
      // Subscribe to config updates
      const configService = getConfigService();
      await configService.subscribe((key, value, action) => {
        log.info(`Config ${action}: ${key} = ${value}`);
      });
      
      log.success('Centralized config service initialized');
    } catch (configErr) {
      log.warn(`Config service init failed (using env fallback): ${configErr.message}`);
    }
    
    // Log mode-specific information
    if (compatibility.isSingleNode()) {
      log.info('Single-node mode features:');
      log.info('  - In-memory job queue');
      log.info('  - JSONL-based deduplication');
      log.info('  - Existing Telegram functionality');
      log.info('  - Graceful degradation support');
    } else {
      log.info('Distributed mode features:');
      log.info('  - Redis-based coordination');
      log.info('  - Horizontal scaling');
      log.info('  - Service health monitoring');
      log.info('  - Automatic fallbacks');
    }

    // Initialize Telegram handler with compatibility layer
    const configService = getConfigService();
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const batchConcurrency = configService.isInitialized()
      ? (configService.get('BATCH_CONCURRENCY') || 1)
      : (parseInt(process.env.BATCH_CONCURRENCY, 10) || 1);

    const handlerOptions = {
      timeoutMs: configService.isInitialized()
        ? configService.get('TIMEOUT_MS')
        : (parseInt(process.env.TIMEOUT_MS, 10) || 60000),
      proxy: configService.isInitialized()
        ? (configService.get('PROXY_SERVER') || null)
        : (process.env.PROXY_SERVER || null),
      targetUrl: configService.isInitialized()
        ? configService.get('TARGET_LOGIN_URL')
        : process.env.TARGET_LOGIN_URL,
      compatibility // Pass compatibility layer to handler
    };

    log.info('Configuration:');
    log.info(`Mode: ${compatibility.getMode()}`);
    log.info(`Timeout: ${handlerOptions.timeoutMs}ms`);
    log.info(`Batch Concurrency: ${batchConcurrency}`);
    log.info(`Proxy: ${handlerOptions.proxy ? handlerOptions.proxy : 'not configured (direct connection)'}`);

    const bot = initializeTelegramHandler(botToken, handlerOptions);

    // Set telegram instance in coordinator if in distributed mode
    if (compatibility.isDistributed && compatibility.isDistributed() && compatibility.setTelegram) {
      compatibility.setTelegram(bot.telegram);
    }

    log.success('Telegram bot initialized successfully!');
    log.info('Polling for messages...');
    log.info('Bot is ready! Send messages to start checking credentials.');
    log.info('Command format: .chk email:password');
    log.info('Press Ctrl+C to stop the bot');

    // Handle graceful shutdown
    let isShuttingDown = false;
    
    const shutdown = async (signal) => {
      // Prevent multiple shutdown attempts
      if (isShuttingDown) {
        log.warn('Shutdown already in progress...');
        return;
      }
      isShuttingDown = true;
      
      log.warn(`\n🛑 Received ${signal} - Graceful shutdown initiated...`);
      
      // Collect all active batches (regular + combine)
      const activeBatches = getAllActiveBatches();
      const activeCombineBatches = getAllActiveCombineBatches();
      const totalActive = activeBatches.length + activeCombineBatches.length;
      
      if (totalActive > 0) {
        log.info(`⏳ Waiting for ${totalActive} active batch(es) to complete...`);
        
        if (activeBatches.length > 0) {
          log.info('  Regular batches: ' + activeBatches.map(b => `${b.filename} (${b.processed}/${b.total})`).join(', '));
        }
        if (activeCombineBatches.length > 0) {
          log.info('  Combine batches: ' + activeCombineBatches.map(b => `${b.filename} (${b.processed}/${b.total})`).join(', '));
        }
        
        const SHUTDOWN_TIMEOUT_MS = 300000; // 5 minutes max wait
        const startWait = Date.now();
        
        // Progress logging interval
        const progressInterval = setInterval(() => {
          const current = getAllActiveBatches().concat(getAllActiveCombineBatches());
          if (current.length > 0) {
            const elapsed = Math.round((Date.now() - startWait) / 1000);
            log.info(`  ⏳ Still waiting (${elapsed}s): ` + current.map(b => `${b.processed}/${b.total}`).join(', '));
          }
        }, 10000); // Log every 10 seconds
        
        try {
          await Promise.race([
            Promise.all([
              waitForAllBatchCompletion(),
              waitForAllCombineBatchCompletion(),
            ]),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Shutdown timeout')), SHUTDOWN_TIMEOUT_MS)
            )
          ]);
          
          clearInterval(progressInterval);
          const waitedMs = Date.now() - startWait;
          log.success(`✅ All batches completed. Waited ${Math.round(waitedMs / 1000)}s`);
        } catch (err) {
          clearInterval(progressInterval);
          log.warn(`⚠️ Shutdown timeout reached after ${SHUTDOWN_TIMEOUT_MS / 1000}s - forcing shutdown`);
          log.warn('Some in-flight credentials may not be saved.');
        }
      } else {
        log.info('No active batches.');
      }
      
      // Shutdown compatibility layer
      log.info('🔧 Shutting down compatibility layer...');
      try {
        await compatibility.shutdown();
        log.success('Compatibility layer shutdown complete.');
      } catch (err) {
        log.warn(`Compatibility layer shutdown error: ${err.message}`);
      }
      
      // Flush any buffered Redis writes
      log.info('💾 Flushing buffered writes...');
      try {
        await flushWriteBuffer();
        log.success('Write buffer flushed.');
      } catch (err) {
        log.warn(`Write buffer flush failed: ${err.message}`);
      }
      
      // Close Redis connection
      log.info('🔌 Closing Redis connection...');
      try {
        await closeStore();
        log.success('Redis connection closed.');
      } catch (err) {
        log.warn(`Redis close failed: ${err.message}`);
      }
      
      // Stop the bot
      log.info('🤖 Stopping Telegram bot...');
      try {
        bot.stop(signal);
        log.success('Bot stopped successfully.');
      } catch (err) {
        log.warn(`Bot stop error: ${err.message}`);
      }
      
      log.info('👋 Goodbye!');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Handle uncaught errors
    process.on('uncaughtException', (err) => {
      log.error('Uncaught Exception:', err.message);
      log.debug(err.stack);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      log.error('Unhandled Rejection at:', promise);
      log.error('Reason:', reason);
    });

  } catch (err) {
    log.error('Fatal startup error:', err.message);
    log.error('Troubleshooting:');
    log.error('1. Check your .env file exists and has correct values');
    log.error('2. Verify your bot token is valid');
    log.error('3. Ensure all dependencies are installed (npm install)');
    log.error('4. Check file permissions');
    log.error('5. For distributed mode, verify Redis connectivity');
    process.exit(1);
  }
}

// Start the bot
main();
