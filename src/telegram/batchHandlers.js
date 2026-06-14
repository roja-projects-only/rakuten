/**
 * =============================================================================
 * BATCH HANDLERS - RE-EXPORT FACADE FOR BACKWARDS COMPATIBILITY
 * =============================================================================
 * 
 * THIS FILE IS NOW A RE-EXPORT FACADE.
 * Actual implementation is in src/telegram/batch/
 * 
 * @see src/telegram/batch/index.js - Main entry point
 * @see src/telegram/batch/batchState.js - State management
 * @see src/telegram/batch/batchExecutor.js - Execution logic
 * @see src/telegram/batch/circuitBreaker.js - Error rate monitoring
 * @see src/telegram/batch/filterUtils.js - Credential filtering
 * @see src/telegram/batch/documentHandler.js - File upload handling
 * @see src/telegram/batch/handlers/ - Type-specific handlers
 * 
 * =============================================================================
 */

// Re-export everything from the modularized batch directory
module.exports = require('./batch');
