/**
 * =============================================================================
 * BATCH HANDLERS - RE-EXPORT FACADE FOR BACKWARDS COMPATIBILITY
 * =============================================================================
 * 
 * THIS FILE IS NOW A RE-EXPORT FACADE.
 * Actual implementation is in telegram/batch/
 * 
 * @see telegram/batch/index.js - Main entry point
 * @see telegram/batch/batchState.js - State management
 * @see telegram/batch/batchExecutor.js - Execution logic
 * @see telegram/batch/circuitBreaker.js - Error rate monitoring
 * @see telegram/batch/filterUtils.js - Credential filtering
 * @see telegram/batch/documentHandler.js - File upload handling
 * @see telegram/batch/handlers/ - Type-specific handlers
 * 
 * =============================================================================
 */

// Re-export everything from the modularized batch directory
module.exports = require('./batch');
