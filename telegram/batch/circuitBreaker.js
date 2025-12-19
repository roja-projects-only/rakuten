/**
 * =============================================================================
 * CIRCUIT BREAKER - Error rate monitoring and auto-pause
 * =============================================================================
 * 
 * Monitors error rates during batch processing and pauses when threshold exceeded.
 * Prevents overwhelming target server during high error periods.
 * 
 * =============================================================================
 */

const { createLogger } = require('../../logger');
const log = createLogger('circuit-breaker');

// Configuration
const ERROR_THRESHOLD_PERCENT = 60;
const ERROR_WINDOW_SIZE = 5;
const CIRCUIT_BREAKER_PAUSE_MS = 3000;

/**
 * Creates a new circuit breaker instance.
 * @returns {Object} Circuit breaker with check and record methods
 */
function createCircuitBreaker() {
  const recentResults = [];
  let tripped = false;
  let consecutiveErrors = 0;
  
  return {
    /**
     * Records a result and updates error tracking.
     * @param {string} status - Result status (VALID, INVALID, BLOCKED, ERROR)
     */
    recordResult(status) {
      recentResults.push(status);
      if (recentResults.length > ERROR_WINDOW_SIZE) {
        recentResults.shift();
      }
      
      if (status === 'ERROR') {
        consecutiveErrors++;
      } else {
        consecutiveErrors = 0;
      }
    },
    
    /**
     * Checks if circuit breaker should trip and pause processing.
     * @returns {{ shouldPause: boolean, pauseMs: number }} Whether to pause and for how long
     */
    check() {
      if (recentResults.length < ERROR_WINDOW_SIZE) {
        return { shouldPause: false, pauseMs: 0 };
      }
      
      const errorCount = recentResults.filter(r => r === 'ERROR').length;
      const errorRate = (errorCount / recentResults.length) * 100;
      
      if (errorRate >= ERROR_THRESHOLD_PERCENT) {
        if (!tripped) {
          tripped = true;
          log.warn(`Circuit breaker tripped: ${errorRate.toFixed(0)}% errors in last ${ERROR_WINDOW_SIZE} - pausing ${CIRCUIT_BREAKER_PAUSE_MS}ms`);
        }
        return { shouldPause: true, pauseMs: CIRCUIT_BREAKER_PAUSE_MS };
      }
      
      tripped = false;
      return { shouldPause: false, pauseMs: 0 };
    },
    
    /**
     * Resets the circuit breaker state after a pause.
     */
    reset() {
      recentResults.length = 0;
      consecutiveErrors = 0;
      tripped = false;
    },
    
    /**
     * Gets current consecutive error count.
     * @returns {number}
     */
    getConsecutiveErrors() {
      return consecutiveErrors;
    },
  };
}

module.exports = {
  createCircuitBreaker,
  ERROR_THRESHOLD_PERCENT,
  ERROR_WINDOW_SIZE,
  CIRCUIT_BREAKER_PAUSE_MS,
};

