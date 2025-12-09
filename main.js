/**
 * =============================================================================
 * RAKUTEN TELEGRAM BOT - MAIN ENTRY POINT
 * =============================================================================
 * 
 * This is the bootstrap layer for the Rakuten credential checker bot.
 * 
 * Responsibilities:
 *   - Load environment configuration
 *   - Validate required settings
 *   - Initialize Telegram bot handler
 *   - Setup graceful shutdown handlers
 *   - Display startup configuration
 * 
 * Environment Variables Required:
 *   - TELEGRAM_BOT_TOKEN: Bot token from @BotFather
 *   - TARGET_LOGIN_URL: Rakuten login URL
 * 
 * Optional Environment Variables:
 *   - TIMEOUT_MS: Operation timeout (default: 60000)
 *   - SCREENSHOT_ON: Enable screenshots (default: false)
 *   - PROXY_SERVER: Proxy URL for requests
 * 
 * =============================================================================
 */

require('dotenv').config();
const { initializeTelegramHandler } = require('./telegramHandler');
const fs = require('fs');
const path = require('path');

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

  console.log('✓ Environment variables validated.');
}

/**
 * Ensures required directories exist.
 */
function ensureDirectories() {
  const dirs = ['screenshots'];
  
  dirs.forEach(dir => {
    const dirPath = path.join(process.cwd(), dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      console.log(`✓ Created directory: ${dir}/`);
    }
  });
}

/**
 * Display startup banner.
 */
function displayBanner() {
  console.clear();
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║                                                           ║');
  console.log('║        🎌  RAKUTEN CREDENTIAL CHECKER BOT  🎌           ║');
  console.log('║                                                           ║');
  console.log('║           Automated Account Verification System          ║');
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
    console.log('🚀 Starting bot initialization...\n');

    // Validate environment
    validateEnvironment();

    // Ensure directories
    ensureDirectories();

    // Initialize Telegram handler
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const handlerOptions = {
      timeoutMs: parseInt(process.env.TIMEOUT_MS, 10) || 60000,
      proxy: process.env.PROXY_SERVER || null,
      screenshotOn: process.env.SCREENSHOT_ON === 'true',
      targetUrl: process.env.TARGET_LOGIN_URL,
    };

    console.log('');
    console.log('⚙️  Configuration:');
    console.log('─────────────────────────────────────────────────────');
    console.log(`   Target URL:    ${handlerOptions.targetUrl.substring(0, 60)}...`);
    console.log(`   Timeout:       ${handlerOptions.timeoutMs}ms`);
    console.log(`   Screenshots:   ${handlerOptions.screenshotOn ? 'Enabled' : 'Disabled'}`);
    if (handlerOptions.proxy) {
      console.log(`   Proxy:         ${handlerOptions.proxy}`);
    }
    console.log(`   Random UA:     Enabled`);
    console.log('─────────────────────────────────────────────────────');
    console.log('');

    const bot = initializeTelegramHandler(botToken, handlerOptions);

    console.log('✓ Telegram bot initialized successfully!');
    console.log('✓ Polling for messages...\n');
    console.log('📱 Bot is ready! Send messages to start checking credentials.');
    console.log('💡 Command format: .chk email:password\n');
    console.log('🔄 Press Ctrl+C to stop the bot\n');

    // Handle graceful shutdown
    const shutdown = async (signal) => {
      console.log(`\n\n⏹️  Received ${signal} - Shutting down gracefully...`);
      console.log('🛑 Stopping polling...');
      
      try {
        await bot.stopPolling();
        console.log('✓ Bot stopped successfully.');
      } catch (err) {
        console.error('⚠️  Error stopping bot:', err.message);
      }
      
      console.log('👋 Goodbye!\n');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Handle uncaught errors
    process.on('uncaughtException', (err) => {
      console.error('\n❌ Uncaught Exception:', err.message);
      console.error(err.stack);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('\n❌ Unhandled Rejection at:', promise);
      console.error('Reason:', reason);
    });

  } catch (err) {
    console.error('\n❌ Fatal startup error:', err.message);
    console.error('\n💡 Troubleshooting:');
    console.error('   1. Check your .env file exists and has correct values');
    console.error('   2. Verify your bot token is valid');
    console.error('   3. Ensure all dependencies are installed (npm install)');
    console.error('   4. Check file permissions\n');
    process.exit(1);
  }
}

// Start the bot
main();
