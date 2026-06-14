/**
 * =============================================================================
 * MESSAGES - RE-EXPORT FACADE FOR BACKWARDS COMPATIBILITY
 * =============================================================================
 * 
 * THIS FILE IS NOW A RE-EXPORT FACADE.
 * Actual implementation is in src/telegram/messages/
 * 
 * @see src/telegram/messages/index.js - Main entry point
 * @see src/telegram/messages/helpers.js - MarkdownV2 helpers
 * @see src/telegram/messages/static.js - Start/help/guide messages
 * @see src/telegram/messages/checkMessages.js - Single check messages
 * @see src/telegram/messages/captureMessages.js - Data capture messages
 * @see src/telegram/messages/batchMessages.js - Batch processing messages
 * 
 * =============================================================================
 */

// Re-export everything from the modularized messages directory
module.exports = require('./messages/index');
