/**
 * Timeout error for operations that exceed their deadline.
 */
const AppError = require('./AppError');

class TimeoutError extends AppError {
  constructor(message = 'Operation timed out', timeoutMs = 0) {
    super(message, 'TIMEOUT', 408);
    this.timeoutMs = timeoutMs;
  }
}

module.exports = TimeoutError;
