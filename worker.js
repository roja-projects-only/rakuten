#!/usr/bin/env node

/**
 * Standalone Worker Process for Distributed Credential Checking
 * 
 * This script creates and runs a WorkerNode instance that:
 * - Connects to Redis queue
 * - Pulls and processes credential checking tasks
 * - Sends heartbeats to coordinator
 * - Handles graceful shutdown on SIGTERM
 * 
 * Usage:
 *   node worker.js
 * 
 * Environment Variables:
 *   REDIS_URL - Redis connection URL
 *   POW_SERVICE_URL - POW service endpoint
 *   WORKER_ID - Optional worker identifier (auto-generated if not set)
 *   LOG_LEVEL - Logging level (debug, info, warn, error)
 */

const { createLogger } = require('./logger');
const { initRedisClient, getPubSubClient } = require('./shared/redis/client');
const { initConfigService, getConfigService } = require('./shared/config/configService');
const WorkerNode = require('./shared/worker/WorkerNode');

const log = createLogger('worker-main');

// Validate required environment variables
function validateEnvironment() {
  const required = ['REDIS_URL'];
  const missing = required.filter(env => !process.env[env]);
  
  if (missing.length > 0) {
    log.error('Missing required environment variables', { missing });
    process.exit(1);
  }
  
  log.info('Environment validation passed', {
    redisUrl: process.env.REDIS_URL ? 'configured' : 'missing',
    powServiceUrl: process.env.POW_SERVICE_URL || 'not configured',
    workerId: process.env.WORKER_ID || 'auto-generated',
    logLevel: process.env.LOG_LEVEL || 'info',
    proxy: process.env.PROXY_SERVER || 'not configured (using pool from coordinator)'
  });
}

// Main worker process
async function main() {
  log.info('Starting distributed worker node');
  
  try {
    // Validate environment
    validateEnvironment();
    
    // Initialize Redis client
    log.info('Connecting to Redis...');
    const redisClient = await initRedisClient();
    
    // Test Redis connection
    const isHealthy = await redisClient.isHealthy();
    if (!isHealthy) {
      throw new Error('Redis connection is not healthy');
    }
    
    log.info('Redis connection established');
    
    // Initialize centralized config service
    try {
      log.info('Initializing centralized config service...');
      const pubSubClient = getPubSubClient();
      await pubSubClient.connect();
      
      await initConfigService(redisClient, pubSubClient);
      
      // Subscribe to config updates
      const configService = getConfigService();
      await configService.subscribe((key, value, action) => {
        log.info(`Config ${action}: ${key} = ${value}`);
      });
      
      log.info('Centralized config service initialized');
    } catch (configErr) {
      log.warn(`Config service init failed (using env fallback): ${configErr.message}`);
    }
    
    // Create worker node
    const worker = new WorkerNode(redisClient, {
      workerId: process.env.WORKER_ID,
      powServiceUrl: process.env.POW_SERVICE_URL,
      taskTimeout: parseInt(process.env.WORKER_TASK_TIMEOUT, 10) || 120000,
      heartbeatInterval: parseInt(process.env.WORKER_HEARTBEAT_INTERVAL, 10) || 10000,
      queueTimeout: parseInt(process.env.WORKER_QUEUE_TIMEOUT, 10) || 30000
    });
    
    // Set up signal handlers for graceful shutdown
    process.on('SIGTERM', () => {
      log.info('Received SIGTERM, initiating graceful shutdown');
      worker.handleShutdown('SIGTERM');
    });
    
    process.on('SIGINT', () => {
      log.info('Received SIGINT, initiating graceful shutdown');
      worker.handleShutdown('SIGINT');
    });
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      log.error('Uncaught exception', { error: error.message, stack: error.stack });
      worker.handleShutdown('UNCAUGHT_EXCEPTION');
    });
    
    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      log.error('Unhandled promise rejection', { 
        reason: reason?.message || reason,
        stack: reason?.stack
      });
      worker.handleShutdown('UNHANDLED_REJECTION');
    });
    
    // Start the worker
    log.info(`Worker node starting with ID: ${worker.workerId}`);
    await worker.run();
    
  } catch (error) {
    log.error('Worker startup failed', { 
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Handle process exit
process.on('exit', (code) => {
  log.info(`Worker process exiting with code ${code}`);
});

// Start the worker
if (require.main === module) {
  main().catch((error) => {
    log.error('Fatal error in worker main', { 
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  });
}

module.exports = { main };