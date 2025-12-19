/**
 * =============================================================================
 * MESSAGES - RE-EXPORT FACADE FOR BACKWARDS COMPATIBILITY
 * =============================================================================
 * 
 * THIS FILE IS NOW A RE-EXPORT FACADE.
 * Actual implementation is in telegram/messages/
 * 
 * @see telegram/messages/index.js - Main entry point
 * @see telegram/messages/helpers.js - MarkdownV2 helpers
 * @see telegram/messages/static.js - Start/help/guide messages
 * @see telegram/messages/checkMessages.js - Single check messages
 * @see telegram/messages/captureMessages.js - Data capture messages
 * @see telegram/messages/batchMessages.js - Batch processing messages
 * 
 * =============================================================================
 */

// Re-export everything from the modularized messages directory
module.exports = require('./messages/index');
