/**
 * Custom error classes for consistent error handling across services.
 */
const AppError = require('./AppError');
const RetryableError = require('./RetryableError');
const TimeoutError = require('./TimeoutError');
const ValidationError = require('./ValidationError');

module.exports = {
  AppError,
  RetryableError,
  TimeoutError,
  ValidationError,
};
