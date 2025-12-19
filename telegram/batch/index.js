/**
 * =============================================================================
 * BATCH HANDLERS - Main entry point for batch processing
 * =============================================================================
 * 
 * THIS FILE IS THE RE-EXPORT FACADE FOR THE MODULARIZED BATCH SYSTEM.
 * 
 * @see telegram/batch/batchState.js - State management
 * @see telegram/batch/batchExecutor.js - Execution logic
 * @see telegram/batch/circuitBreaker.js - Error rate monitoring
 * @see telegram/batch/filterUtils.js - Credential filtering
 * @see telegram/batch/documentHandler.js - File upload handling
 * @see telegram/batch/handlers/ - Type-specific handlers
 * 
 * =============================================================================
 */

const { createLogger } = require('../../logger');
const { escapeV2, formatDurationMs } = require('../messages');

// Import all handlers
const { registerDocumentHandler } = require('./documentHandler');
const { registerCommonHandlers } = require('./handlers/common');
const { registerHotmailHandler } = require('./handlers/hotmail');
const { registerUlpHandler } = require('./handlers/ulp');
const { registerJpHandler } = require('./handlers/jp');
const { registerAllHandler } = require('./handlers/all');

// Re-export state management
const {
  abortActiveBatch,
  hasActiveBatch,
  getAllActiveBatches,
  waitForAllBatchCompletion,
} = require('./batchState');

const log = createLogger('batch');

/**
 * Registers all batch handlers with the bot.
 * @param {Telegraf} bot - Telegraf bot instance
 * @param {Object} options - Options including checkCredentials function
 * @param {Object} helpers - Helper functions
 */
function registerBatchHandlers(bot, options, helpers) {
  const { checkCredentials } = options;

  if (typeof checkCredentials !== 'function') {
    throw new Error('registerBatchHandlers requires options.checkCredentials');
  }

  // Merge helpers with our imports
  const mergedHelpers = {
    escapeV2,
    formatDurationMs,
    ...helpers,
  };

  // Register all handlers
  registerDocumentHandler(bot);
  registerCommonHandlers(bot, options, mergedHelpers);
  registerHotmailHandler(bot);
  registerUlpHandler(bot);
  registerJpHandler(bot);
  registerAllHandler(bot);

  log.info('Batch handlers registered');
}

module.exports = {
  registerBatchHandlers,
  abortActiveBatch,
  hasActiveBatch,
  getAllActiveBatches,
  waitForAllBatchCompletion,
};

