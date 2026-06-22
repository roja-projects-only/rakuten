/**
 * Coordinator Service Entrypoint
 *
 * Starts the Telegram bot with distributed coordination mode.
 * Always runs as coordinator.
 *
 * Required env:
 *   TELEGRAM_BOT_TOKEN, TARGET_LOGIN_URL, REDIS_URL
 */

require('dotenv').config();
const { Telegraf } = require('telegraf');
const { createLogger } = require('../shared/logger');
const { validateEnvironment } = require('../shared/config/environment');
const { initConfigService, getConfigService } = require('../shared/config/configService');
const { getRedisClient, getPubSubClient } = require('../shared/redis/client');
const Coordinator = require('./Coordinator');
const { initializeTelegramHandler } = require('../telegram/telegramHandler');
const {
  getAllActiveBatches,
  waitForAllBatchCompletion,
} = require('../telegram/batch/index');
const {
  getAllActiveCombineBatches,
  waitForAllCombineBatchCompletion,
} = require('../telegram/combineBatchRunner');
const { flushWriteBuffer, closeStore } = require('../shared/batch/processedStore');

const log = createLogger('coordinator-main');

async function main() {
  try {
    log.info('Starting coordinator service...');

    // 1. Validate environment — coordinator requires REDIS_URL, TELEGRAM_BOT_TOKEN, TARGET_LOGIN_URL
    const { config } = validateEnvironment('coordinator');
    log.info('Environment validated for coordinator mode');

    // 2. Connect Redis
    log.info('Connecting to Redis...');
    const redisClient = getRedisClient();
    await redisClient.connect();

    const pubSubClient = getPubSubClient();
    await pubSubClient.connect();
    log.info('Redis connected');

    // 3. Initialize centralized config service
    try {
      await initConfigService(redisClient, pubSubClient);
      const configService = getConfigService();
      await configService.subscribe((key, value, action) => {
        log.info(`Config ${action}: ${key} = ${value}`);
      });
      log.info('Config service initialized');
    } catch (err) {
      log.warn(`Config service init failed (using env fallback): ${err.message}`);
    }

    // Sync POW service URL from config service to POW client
    try {
      const configService = getConfigService();
      if (configService.isInitialized()) {
        const powUrl = configService.get('POW_SERVICE_URL');
        if (powUrl) {
          const powServiceClient = require('../shared/fingerprinting/powServiceClient');
          powServiceClient.setServiceUrl(powUrl);
        }
      }
    } catch (err) {
      log.warn(`POW service URL sync failed: ${err.message}`);
    }

    // 4. Initialize Coordinator
    const coordinator = new Coordinator(redisClient, null, {
      channelId: config.FORWARD_CHANNEL_ID || null,
      proxies: config.PROXY_POOL || [],
      metrics: { port: config.METRICS_PORT || 9090 },
    });

    // 5. Initialize Telegram bot
    const configService = getConfigService();
    const botToken = config.TELEGRAM_BOT_TOKEN;
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
      coordinator,
    };

    const bot = await initializeTelegramHandler(botToken, handlerOptions);

    // Wire telegram instance into coordinator for message editing
    coordinator.telegram = bot.telegram;

    // 6. Start coordinator services (heartbeats, pub/sub, metrics, crash recovery)
    await coordinator.start();

    log.success('Coordinator started');
    log.info('Polling for messages...');

    // 7. Graceful shutdown
    let isShuttingDown = false;

    const shutdown = async (signal) => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      log.warn(`Received ${signal} — shutting down...`);

      // Wait for active batches
      const activeBatches = getAllActiveBatches();
      const activeCombineBatches = getAllActiveCombineBatches();
      const totalActive = activeBatches.length + activeCombineBatches.length;

      if (totalActive > 0) {
        log.info(`Waiting for ${totalActive} active batch(es)...`);
        const SHUTDOWN_TIMEOUT_MS = 300000; // 5 minutes

        try {
          await Promise.race([
            Promise.all([
              waitForAllBatchCompletion(),
              waitForAllCombineBatchCompletion(),
            ]),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Shutdown timeout')), SHUTDOWN_TIMEOUT_MS)
            ),
          ]);
          log.success('All batches completed');
        } catch (err) {
          log.warn('Shutdown timeout reached — forcing shutdown');
        }
      }

      // Stop coordinator
      try {
        await coordinator.stop();
      } catch (err) {
        log.warn(`Coordinator stop error: ${err.message}`);
      }

      // Flush processed store
      try {
        await flushWriteBuffer();
        await closeStore();
      } catch (err) {
        log.warn(`Processed store cleanup error: ${err.message}`);
      }

      // Stop bot
      try {
        bot.stop(signal);
      } catch (err) {
        log.warn(`Bot stop error: ${err.message}`);
      }

      log.info('Goodbye!');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (err) => {
      log.error('Uncaught Exception:', err.message);
      process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
      log.error('Unhandled Rejection:', reason);
    });

  } catch (err) {
    log.error('Fatal startup error:', err.message);
    log.error('Troubleshooting:');
    log.error('1. Check .env has TELEGRAM_BOT_TOKEN, TARGET_LOGIN_URL, REDIS_URL');
    log.error('2. Verify Redis is running and accessible');
    log.error('3. Run: npm install');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    log.error('Fatal error', { error: error.message });
    process.exit(1);
  });
}

module.exports = { main, Coordinator };

