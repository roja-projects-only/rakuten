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
const { initializeTelegramHandler } = require('./telegramHandler');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const log = createLogger('main');

/**
 * Validates required environment variables.
 * @throws {Error} If any required variable is missing
 */
function validateEnvironment() {
  const required = ['TELEGRAM_BOT_TOKEN', 'TARGET_LOGIN_URL'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `❌ Missing required environment variables: ${missing.join(', ')}\n\n` +
      '📝 Please create a .env file with:\n' +
      '   TELEGRAM_BOT_TOKEN=your_token_here\n' +
      '   TARGET_LOGIN_URL=https://login.account.rakuten.com/...\n\n' +
      '💡 Copy .env.example to .env and fill in your values.'
    );
  }

  log.success('Environment variables validated.');
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

    // Validate environment
    validateEnvironment();

    // Ensure directories
    ensureDirectories();

    // Initialize Telegram handler
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const batchConcurrency = parseInt(process.env.BATCH_CONCURRENCY, 10) || 1;

    const handlerOptions = {
      timeoutMs: parseInt(process.env.TIMEOUT_MS, 10) || 60000,
      proxy: process.env.PROXY_SERVER || null,
      targetUrl: process.env.TARGET_LOGIN_URL,
    };

    log.info('Configuration:');
    log.info(`Timeout: ${handlerOptions.timeoutMs}ms`);
    log.info(`Batch Concurrency: ${batchConcurrency}`);
    if (handlerOptions.proxy) {
      log.info(`Proxy: ${handlerOptions.proxy}`);
    }

    const bot = initializeTelegramHandler(botToken, handlerOptions);

    log.success('Telegram bot initialized successfully!');
    log.info('Polling for messages...');
    log.info('Bot is ready! Send messages to start checking credentials.');
    log.info('Command format: .chk email:password');
    log.info('Press Ctrl+C to stop the bot');

    // Handle graceful shutdown
    const shutdown = async (signal) => {
      log.warn(`Received ${signal} - Shutting down gracefully...`);
      log.info('Stopping polling...');
      
      try {
        await bot.stopPolling();
        log.success('Bot stopped successfully.');
      } catch (err) {
        log.error('Error stopping bot:', err.message);
      }
      
      log.info('Goodbye!');
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
    process.exit(1);
  }
}

// Start the bot
main();
