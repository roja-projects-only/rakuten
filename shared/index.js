/**
 * Shared Infrastructure for Distributed Worker Architecture
 * 
 * Exports all shared utilities for Redis, logging, and configuration.
 */

// Redis infrastructure
const {
  RedisClient,
  getRedisClient,
  initRedisClient,
  closeRedisClient
} = require('./redis/client');

const {
  TASK_LEASE,
  RESULT_CACHE,
  PROGRESS_TRACKER,
  PROXY_HEALTH,
  MESSAGE_TRACKING,
  COORDINATOR_HEARTBEAT,
  COORDINATOR_LOCK,
  WORKER_HEARTBEAT,
  FORWARD_PENDING,
  POW_CACHE,
  JOB_QUEUE,
  PUBSUB_CHANNELS,
  KEY_PATTERNS,
  generateBatchId,
  generateTaskId,
  generateWorkerId,
  generateTrackingCode,
  parseBatchId,
  validateKey,
  parseKey
} = require('./redis/keys');

// Structured logging
const {
  StructuredLogger,
  createStructuredLogger,
  withTraceId,
  generateTraceId,
  formatStructuredLog,
  LOG_LEVELS,
  getCurrentLogLevel,
  shouldLog
} = require('./logger/structured');

// Environment configuration
const {
  ENV_DEFINITIONS,
  validateEnvironment,
  getConfig,
  isDistributedMode,
  isSingleNodeMode,
  getDeploymentMode,
  printConfigSummary
} = require('./config/environment');

module.exports = {
  // Redis
  RedisClient,
  getRedisClient,
  initRedisClient,
  closeRedisClient,
  
  // Redis Keys
  REDIS_KEYS: {
    TASK_LEASE,
    RESULT_CACHE,
    PROGRESS_TRACKER,
    PROXY_HEALTH,
    MESSAGE_TRACKING,
    COORDINATOR_HEARTBEAT,
    COORDINATOR_LOCK,
    WORKER_HEARTBEAT,
    FORWARD_PENDING,
    POW_CACHE,
    JOB_QUEUE,
    PUBSUB_CHANNELS,
    KEY_PATTERNS
  },
  
  // Key utilities
  generateBatchId,
  generateTaskId,
  generateWorkerId,
  generateTrackingCode,
  parseBatchId,
  validateKey,
  parseKey,
  
  // Logging
  StructuredLogger,
  createStructuredLogger,
  withTraceId,
  generateTraceId,
  formatStructuredLog,
  LOG_LEVELS,
  getCurrentLogLevel,
  shouldLog,
  
  // Configuration
  ENV_DEFINITIONS,
  validateEnvironment,
  getConfig,
  isDistributedMode,
  isSingleNodeMode,
  getDeploymentMode,
  printConfigSummary
};