/**
 * =============================================================================
 * RETRY INTERCEPTOR - Axios retry logic for unstable proxy connections
 * =============================================================================
 * 
 * Adds automatic retry with exponential backoff for network errors.
 * Designed for proxy environments where TLS disconnections are common.
 * 
 * Retryable errors:
 * - ECONNRESET, ECONNREFUSED, ETIMEDOUT, ENOTFOUND
 * - Socket disconnected before TLS
 * - Network errors (no response)
 * 
 * =============================================================================
 */

const { createLogger } = require('../../logger');

const log = createLogger('retry');

// Default retry configuration
const DEFAULT_CONFIG = {
  retries: 3,
  retryDelay: 1000,        // Base delay in ms
  retryDelayMax: 10000,    // Max delay cap
  exponentialBackoff: true,
  retryCondition: null,    // Custom retry condition function
};

// Error codes that should trigger a retry
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ECONNABORTED',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

// Error messages that should trigger a retry
const RETRYABLE_ERROR_MESSAGES = [
  'socket disconnected',
  'socket hang up',
  'Client network socket disconnected',
  'TLS connection was established',
  'read ECONNRESET',
  'write ECONNRESET',
  'connect ETIMEDOUT',
  'getaddrinfo',
  'CERT_HAS_EXPIRED',  // Proxy cert issues
  'unable to verify',
  'self signed certificate',
];

/**
 * Checks if an error is retryable.
 * @param {Error} error - The error to check
 * @returns {boolean} True if the error is retryable
 */
function isRetryableError(error) {
  // No response means network error - usually retryable
  if (!error.response) {
    // Check error code
    if (error.code && RETRYABLE_ERROR_CODES.has(error.code)) {
      return true;
    }
    
    // Check error message
    const message = (error.message || '').toLowerCase();
    for (const pattern of RETRYABLE_ERROR_MESSAGES) {
      if (message.includes(pattern.toLowerCase())) {
        return true;
      }
    }
    
    // Generic network error
    if (error.message && (
      error.message.includes('network') ||
      error.message.includes('timeout') ||
      error.message.includes('socket')
    )) {
      return true;
    }
  }
  
  // 5xx server errors are sometimes retryable
  if (error.response && error.response.status >= 500 && error.response.status < 600) {
    // Don't retry 501 Not Implemented
    return error.response.status !== 501;
  }
  
  // 429 Too Many Requests - retry with backoff
  if (error.response && error.response.status === 429) {
    return true;
  }
  
  return false;
}

/**
 * Calculates delay for next retry attempt.
 * @param {number} attempt - Current attempt number (0-indexed)
 * @param {Object} config - Retry configuration
 * @returns {number} Delay in milliseconds
 */
function calculateDelay(attempt, config) {
  const { retryDelay, retryDelayMax, exponentialBackoff } = config;
  
  let delay;
  if (exponentialBackoff) {
    // Exponential backoff: delay * 2^attempt with jitter
    const exponentialDelay = retryDelay * Math.pow(2, attempt);
    const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
    delay = exponentialDelay + jitter;
  } else {
    delay = retryDelay;
  }
  
  return Math.min(delay, retryDelayMax);
}

/**
 * Sleep helper.
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Attaches retry interceptor to an axios instance.
 * 
 * @param {Object} client - Axios instance
 * @param {Object} [options] - Retry configuration
 * @param {number} [options.retries=3] - Max retry attempts
 * @param {number} [options.retryDelay=1000] - Base delay between retries
 * @param {number} [options.retryDelayMax=10000] - Maximum delay cap
 * @param {boolean} [options.exponentialBackoff=true] - Use exponential backoff
 * @param {Function} [options.retryCondition] - Custom function to determine if retry should occur
 */
function attachRetryInterceptor(client, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  
  // Store original request config for retries
  client.interceptors.request.use((reqConfig) => {
    // Initialize retry state if not present
    if (reqConfig.__retryCount === undefined) {
      reqConfig.__retryCount = 0;
      reqConfig.__retryConfig = config;
    }
    return reqConfig;
  });
  
  // Response interceptor for retry logic
  client.interceptors.response.use(
    // Success - pass through
    (response) => response,
    
    // Error - check if retryable
    async (error) => {
      const reqConfig = error.config;
      
      // No config means we can't retry
      if (!reqConfig) {
        return Promise.reject(error);
      }
      
      const retryConfig = reqConfig.__retryConfig || config;
      const currentAttempt = reqConfig.__retryCount || 0;
      
      // Check if we should retry
      const shouldRetry = retryConfig.retryCondition 
        ? retryConfig.retryCondition(error)
        : isRetryableError(error);
      
      if (!shouldRetry || currentAttempt >= retryConfig.retries) {
        if (currentAttempt > 0) {
          log.warn(`[retry] Giving up after ${currentAttempt} retries: ${error.message}`);
        }
        return Promise.reject(error);
      }
      
      // Calculate delay
      const delay = calculateDelay(currentAttempt, retryConfig);
      
      log.debug(`[retry] Attempt ${currentAttempt + 1}/${retryConfig.retries} after ${Math.round(delay)}ms - ${error.code || error.message}`);
      
      // Wait before retry
      await sleep(delay);
      
      // Increment retry count
      reqConfig.__retryCount = currentAttempt + 1;
      
      // Retry the request
      return client.request(reqConfig);
    }
  );
}

/**
 * Creates a retry-wrapped request function.
 * Useful when you need more control over retry behavior.
 * 
 * @param {Function} requestFn - Async function that makes the request
 * @param {Object} [options] - Retry configuration
 * @returns {Function} Wrapped function with retry logic
 */
function withRetry(requestFn, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  
  return async (...args) => {
    let lastError;
    
    for (let attempt = 0; attempt <= config.retries; attempt++) {
      try {
        return await requestFn(...args);
      } catch (error) {
        lastError = error;
        
        const shouldRetry = config.retryCondition 
          ? config.retryCondition(error)
          : isRetryableError(error);
        
        if (!shouldRetry || attempt >= config.retries) {
          throw error;
        }
        
        const delay = calculateDelay(attempt, config);
        log.debug(`[retry] Attempt ${attempt + 1}/${config.retries} after ${Math.round(delay)}ms - ${error.code || error.message}`);
        
        await sleep(delay);
      }
    }
    
    throw lastError;
  };
}

module.exports = {
  attachRetryInterceptor,
  withRetry,
  isRetryableError,
  calculateDelay,
  DEFAULT_CONFIG,
  RETRYABLE_ERROR_CODES,
};
