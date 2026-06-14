/**
 * Shared modules barrel export.
 * Central entry point for all shared infrastructure.
 */
module.exports = {
  config: require('./config'),
  logger: require('./logger'),
  redis: require('./redis'),
  http: require('./http'),
  batch: require('./batch'),
  fingerprinting: require('./fingerprinting'),
  capture: require('./capture'),
  payloads: require('./payloads'),
  errors: require('./errors'),
  utils: require('./utils'),
  constants: require('./constants'),
};
