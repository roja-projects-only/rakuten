/**
 * Consolidated logger module.
 */
const { createLogger, getCurrentLogLevel, shouldLog } = require('./logger');
const { createStructuredLogger } = require('./structured');

module.exports = {
  createLogger,
  createStructuredLogger,
  getCurrentLogLevel,
  shouldLog,
};
