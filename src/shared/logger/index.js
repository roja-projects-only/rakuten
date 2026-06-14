/**
 * Consolidated logger module.
 * Merged from root logger.js and shared/logger/structured.js
 */
const logger = require('./logger');
const structured = require('./structured');

module.exports = {
  ...logger,
  ...structured,
  // Explicit re-exports for clarity
  createLogger: logger.createLogger,
};
