/**
 * Error that can be retried.
 * Used for transient failures (network, timeout, rate limit).
 */
const AppError = require('./AppError');

class RetryableError extends AppError {
  constructor(message, code = 'RETRYABLE_ERROR', retryAfterMs = 0) {
    super(message, code, 503);
    this.retryAfterMs = retryAfterMs;
  }
}

module.exports = RetryableError;
