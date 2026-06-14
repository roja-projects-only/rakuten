/**
 * =============================================================================
 * BATCH EXECUTOR - Core batch processing execution logic
 * =============================================================================
 * 
 * Handles the actual execution of batch credential checking including:
 * - Chunk-based parallel processing
 * - Progress updates
 * - Circuit breaker integration
 * - Result tracking
 * 
 * =============================================================================
 */

const { createLogger } = require('../../shared/logger');
const {
  makeKey,
  markProcessedStatus,
  flushWriteBuffer,
} = require('../../shared/batch/processedStore');
const {
  buildBatchProgress,
  buildBatchSummary,
  buildBatchAborted,
  buildBatchFailed,
  buildBatchAborting,
  buildCheckAndCaptureResult,
} = require('../messages');
const { captureAccountData } = require('../../shared/capture');
const { closeSession } = require('../../shared/http/sessionManager');
const { setActiveBatch, clearActiveBatch, deletePendingBatch } = require('./batchState');
const { createCircuitBreaker } = require('./circuitBreaker');
const { getConfigService } = require('../../shared/config/configService');

const log = createLogger('batch-executor');

// Progress update interval (not configurable)
const PROGRESS_UPDATE_INTERVAL_MS = 2000;

/**
 * Get batch configuration from config service (hot-reloadable) or env fallback
 */
function getBatchConfig() {
  const configService = getConfigService();
  if (configService.isInitialized()) {
    return {
      concurrency: Math.max(1, configService.get('BATCH_CONCURRENCY') || 1),
      maxRetries: configService.get('BATCH_MAX_RETRIES') || 1,
      delayMs: configService.get('BATCH_DELAY_MS') || 50,
      processedTtlMs: configService.get('PROCESSED_TTL_MS') || 7 * 24 * 60 * 60 * 1000
    };
  }
  // Fallback to env
  return {
    concurrency: Math.max(1, parseInt(process.env.BATCH_CONCURRENCY, 10) || 1),
    maxRetries: parseInt(process.env.BATCH_MAX_RETRIES, 10) || 1,
    delayMs: parseInt(process.env.BATCH_DELAY_MS, 10) || 50,
    processedTtlMs: parseInt(process.env.PROCESSED_TTL_MS, 10) || 7 * 24 * 60 * 60 * 1000
  };
}

/**
 * Runs the batch execution for a set of credentials.
 * @param {Object} ctx - Telegraf context
 * @param {Object} batch - Batch object with creds, filename, count
 * @param {string} msgId - Source message ID
 * @param {Object} statusMsg - Status message to update
 * @param {Object} options - Check options (timeoutMs, proxy, targetUrl, coordinator)
 * @param {Object} helpers - Helper functions (escapeV2, formatDurationMs)
 * @param {string} key - Batch key for state management
 * @param {Function} checkCredentials - Credential checking function
 */
function runBatchExecution(ctx, batch, msgId, statusMsg, options, helpers, key, checkCredentials) {
  const chatId = ctx.chat.id;
  
  // Get hot-reloadable config at execution time
  const batchConfig = getBatchConfig();
  const BATCH_CONCURRENCY = batchConfig.concurrency;
  const MAX_RETRIES = batchConfig.maxRetries;
  const REQUEST_DELAY_MS = batchConfig.delayMs;
  const PROCESSED_TTL_MS = batchConfig.processedTtlMs;
  
  // Always queue to Redis for distributed worker processing
  log.info(`Queuing ${batch.count} tasks to Redis for distributed processing`);
  return runDistributedBatch(ctx, batch, msgId, statusMsg, options, helpers, key);
}

/**
 * Queue batch to Redis for distributed worker processing
 */
async function runDistributedBatch(ctx, batch, msgId, statusMsg, options, helpers, key) {
  const chatId = ctx.chat.id;
  
  try {
    const coordinator = options.coordinator;
    
    if (!coordinator || !coordinator.jobQueue) {
      log.error('Coordinator not available — options keys:', Object.keys(options));
      throw new Error('Coordinator not initialized — jobQueue not available');
    }
    
    log.info(`Queuing ${batch.count} credentials to job queue`);
    
    // Generate batch ID
    const { generateBatchId } = require('../../shared/redis/keys');
    const batchId = generateBatchId();
    
    // Queue the batch with correct parameters
    const result = await coordinator.jobQueue.enqueueBatch(
      batchId,
      batch.creds,
      {
        batchType: 'HOTMAIL', // or determine from context
        chatId,
        filename: batch.filename,
        userId: ctx.from.id
      }
    );
    
    // Update message with initial progress format (0 processed)
    const { buildBatchProgress } = require('../messages');
    const text = buildBatchProgress({
      filename: batch.filename,
      processed: 0,
      total: result.queued,
      counts: { VALID: 0, INVALID: 0, BLOCKED: 0, ERROR: 0 },
      validCreds: [],
      cached: result.cached
    });
    
    await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, text, {
      parse_mode: 'MarkdownV2',
    });
    
    log.info(`Batch queued successfully: ${batchId}`);
    
    // Initialize progress tracker with the Telegram message
    await coordinator.progressTracker.initBatch(
      batchId,
      result.queued,
      chatId,
      statusMsg.message_id,
      batch.filename
    );
    
    // Subscribe to progress updates for this batch
    coordinator.progressTracker.startTracking(batchId, batch.filename);
    
    // Pin the progress message
    ctx.telegram.pinChatMessage(chatId, statusMsg.message_id, { disable_notification: true }).catch(err => {
      log.debug(`Failed to pin message: ${err.message}`);
    });
    
  } catch (error) {
    log.error('Failed to queue batch', { error: error.message });
    
    const errorText = helpers.escapeV2(`❌ Failed to queue batch\n\n` +
      `Error: ${error.message}\n\n` +
      `Please try again or contact support.`);
    
    await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, errorText, {
      parse_mode: 'MarkdownV2',
    });
  }
}

module.exports = {
  runBatchExecution,
  getBatchConfig,
  PROGRESS_UPDATE_INTERVAL_MS,
};
