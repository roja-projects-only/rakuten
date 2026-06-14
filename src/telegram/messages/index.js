/**
 * =============================================================================
 * MESSAGES - Re-export all message builders
 * =============================================================================
 * 
 * THIS FILE IS THE MAIN ENTRY POINT FOR THE MESSAGES MODULE.
 * 
 * @see src/telegram/messages/helpers.js - MarkdownV2 helpers
 * @see src/telegram/messages/static.js - Start/help/guide messages
 * @see src/telegram/messages/checkMessages.js - Single check messages
 * @see src/telegram/messages/captureMessages.js - Data capture messages
 * @see src/telegram/messages/batchMessages.js - Batch processing messages
 * 
 * =============================================================================
 */

// Re-export everything from sub-modules
const helpers = require('./helpers');
const static_ = require('./static');
const checkMessages = require('./checkMessages');
const captureMessages = require('./captureMessages');
const batchMessages = require('./batchMessages');

module.exports = {
  // Helpers
  ...helpers,
  
  // Static messages
  ...static_,
  
  // Check messages
  ...checkMessages,
  
  // Capture messages
  ...captureMessages,
  
  // Batch messages
  ...batchMessages,
};
