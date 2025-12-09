/**
 * Main entry point for the Rakuten Telegram Credential Checker bot.
 * Bootstraps environment variables, initializes dependencies, and starts the bot.
 */

require('dotenv').config();
const { initializeTelegramHandler } = require('./telegramHandler');

/**
 * Validates required environment variables.
 * @throws {Error} If any required variable is missing
 */
function validateEnvironment() {
  const required = ['TELEGRAM_BOT_TOKEN', 'TARGET_LOGIN_URL'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
      'Please check your .env file.'
    );
  }

  console.log('✓ Environment variables validated.');
}

/**
 * Main bot initialization and startup.
 */
async function main() {
  try {
    console.log('🚀 Starting Rakuten Telegram Credential Checker...\n');

    // Validate environment
    validateEnvironment();

    // Initialize Telegram handler
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const handlerOptions = {
      timeoutMs: parseInt(process.env.TIMEOUT_MS, 10) || 60000,
      proxy: process.env.PROXY_SERVER,
      screenshotOn: process.env.SCREENSHOT_ON === 'true',
      targetUrl: process.env.TARGET_LOGIN_URL,
    };

    const bot = initializeTelegramHandler(botToken, handlerOptions);

    console.log('✓ Telegram bot initialized.');
    console.log('✓ Polling for messages...\n');
    console.log('Configuration:');
    console.log(`  • Target URL: ${process.env.TARGET_LOGIN_URL}`);
    console.log(`  • Timeout: ${handlerOptions.timeoutMs}ms`);
    if (handlerOptions.proxy) {
      console.log(`  • Proxy: ${handlerOptions.proxy}`);
    }
    console.log(`  • Screenshot on error: ${handlerOptions.screenshotOn}\n`);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n⏹️  Shutting down gracefully...');
      bot.stopPolling();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\n⏹️  Shutting down gracefully...');
      bot.stopPolling();
      process.exit(0);
    });
  } catch (err) {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
  }
}

// Start the bot
main();
