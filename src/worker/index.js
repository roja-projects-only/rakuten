/**
 * Worker Service Entrypoint
 *
 * Starts a distributed credential-checking worker node.
 * Always runs as worker.
 *
 * Required env:
 *   REDIS_URL, TARGET_LOGIN_URL
 * Optional:
 *   WORKER_ID, WORKER_CONCURRENCY, POW_SERVICE_URL, WORKER_TASK_TIMEOUT,
 *   WORKER_HEARTBEAT_INTERVAL, WORKER_QUEUE_TIMEOUT
 */

require('dotenv').config();
const { createLogger } = require('../shared/logger');
const { initRedisClient, getPubSubClient } = require('../shared/redis/client');
const { initConfigService, getConfigService } = require('../shared/config/configService');
const WorkerNode = require('./WorkerNode');

const log = createLogger('worker-main');

async function main() {
  log.info('Starting distributed worker node');

  try {
    // 1. Validate required env
    if (!process.env.REDIS_URL) {
      log.error('Missing required environment variable: REDIS_URL');
      process.exit(1);
    }
    // TARGET_LOGIN_URL is required for credential checking at task execution time.
    // Validating here gives a clear startup failure instead of a confusing late error
    // inside checkCredentials() during the first dequeued task.
    if (!process.env.TARGET_LOGIN_URL) {
      log.error('Missing required environment variable: TARGET_LOGIN_URL');
      process.exit(1);
    }

    // 2. Connect Redis
    log.info('Connecting to Redis...');
    const redisClient = await initRedisClient();
    const isHealthy = await redisClient.isHealthy();
    if (!isHealthy) {
      throw new Error('Redis connection is not healthy');
    }
    log.info('Redis connected');

    // 3. Initialize config service
    try {
      const pubSubClient = getPubSubClient();
      await pubSubClient.connect();
      await initConfigService(redisClient, pubSubClient);
      const configService = getConfigService();
      await configService.subscribe((key, value, action) => {
        log.info(`Config ${action}: ${key} = ${value}`);
      });
      log.info('Config service initialized');
    } catch (configErr) {
      log.warn(`Config service init failed (using env fallback): ${configErr.message}`);
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

    // 4. Create and run worker
    const worker = new WorkerNode(redisClient, {
      workerId: process.env.WORKER_ID,
      powServiceUrl: process.env.POW_SERVICE_URL,
      taskTimeout: parseInt(process.env.WORKER_TASK_TIMEOUT, 10) || 120000,
      heartbeatInterval: parseInt(process.env.WORKER_HEARTBEAT_INTERVAL, 10) || 10000,
      queueTimeout: parseInt(process.env.WORKER_QUEUE_TIMEOUT, 10) || 30000,
    });

    // 5. Register shutdown handlers
    process.on('SIGTERM', () => worker.handleShutdown('SIGTERM'));
    process.on('SIGINT', () => worker.handleShutdown('SIGINT'));
    process.on('uncaughtException', (error) => {
      log.error('Uncaught exception', { error: error.message, stack: error.stack });
      worker.handleShutdown('UNCAUGHT_EXCEPTION');
    });
    process.on('unhandledRejection', (reason) => {
      log.error('Unhandled rejection', { reason: reason?.message || reason });
    });

    log.info(`Worker starting with ID: ${worker.workerId}`);
    await worker.run();

  } catch (error) {
    log.error('Worker startup failed', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

process.on('exit', (code) => {
  log.info(`Worker process exiting with code ${code}`);
});

if (require.main === module) {
  main().catch((error) => {
    log.error('Fatal error', { error: error.message });
    process.exit(1);
  });
}

module.exports = { main };
