/**
 * =============================================================================
 * RETRY WITH BACKOFF - Exponential backoff retry utility
 * =============================================================================
 * 
 * Provides a reusable retry mechanism with exponential backoff.
 * Used in batch processing, POW computation, and HTTP requests.
 * 
 * =============================================================================
 */

const { createLogger } = require('../logger');
const log = createLogger('retry');

/**
 * Default options for retry with backoff.
 */
const DEFAULT_OPTIONS = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitterMs: 300,
  shouldRetry: () => true,
  onRetry: null,
};

/**
 * Executes a function with exponential backoff retry.
 * 
 * @param {Function} fn - Async function to execute
 * @param {Object} options - Retry options
 * @param {number} [options.maxRetries=3] - Maximum number of retries
 * @param {number} [options.baseDelayMs=500] - Base delay between retries
 * @param {number} [options.maxDelayMs=30000] - Maximum delay cap
 * @param {number} [options.backoffMultiplier=2] - Delay multiplier per retry
 * @param {number} [options.jitterMs=300] - Random jitter range
 * @param {Function} [options.shouldRetry] - Function to determine if retry should occur
 * @param {Function} [options.onRetry] - Callback on each retry (attempt, error, delay)
 * @returns {Promise<any>} Result from successful execution
 * @throws {Error} Last error if all retries exhausted
 */
async function retryWithBackoff(fn, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError;
  
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      
      // Check if we should retry
      if (attempt >= opts.maxRetries || !opts.shouldRetry(error, attempt)) {
        throw error;
      }
      
      // Calculate delay with exponential backoff and jitter
      const exponentialDelay = opts.baseDelayMs * Math.pow(opts.backoffMultiplier, attempt);
      const jitter = Math.random() * opts.jitterMs;
      const delay = Math.min(exponentialDelay + jitter, opts.maxDelayMs);
      
      log.debug(`Retry ${attempt + 1}/${opts.maxRetries}: ${error.message} (waiting ${delay.toFixed(0)}ms)`);
      
      // Call onRetry callback if provided
      if (opts.onRetry) {
        opts.onRetry(attempt + 1, error, delay);
      }
      
      await sleep(delay);
    }
  }
  
  throw lastError;
}

/**
 * Creates a retry-wrapped version of an async function.
 * 
 * @param {Function} fn - Async function to wrap
 * @param {Object} options - Retry options
 * @returns {Function} Wrapped function with retry behavior
 */
function withRetry(fn, options = {}) {
  return (...args) => retryWithBackoff(() => fn(...args), options);
}

/**
 * Simple sleep helper.
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  retryWithBackoff,
  withRetry,
  sleep,
  DEFAULT_OPTIONS,
};

