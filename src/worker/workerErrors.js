/**
 * Worker Error Classification
 *
 * Distinguishes fatal errors (should shut down worker) from transient errors
 * (should retry).  Used by the main loop and heartbeat to decide the severity
 * of a failure.
 */

/**
 * Check if error is fatal (should cause worker shutdown)
 * @param {Error} error - Error to check
 * @returns {boolean} True if fatal
 */
function isFatalError(error) {
  if (!error || !error.message) return false;

  // Timeout errors are not fatal — they're expected during normal operation
  if (
    error.message.includes('Command timed out') ||
    error.message.includes('timeout')
  ) {
    return false;
  }

  // Redis connection errors are fatal
  if (
    error.message.includes('Connection is closed') ||
    error.message.includes('ECONNREFUSED') ||
    error.message.includes('ENOTFOUND') ||
    error.message.includes('Redis connection')
  ) {
    return true;
  }

  return false;
}

module.exports = { isFatalError };
