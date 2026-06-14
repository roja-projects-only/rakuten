/**
 * Credential check status codes.
 */
const STATUS_CODES = {
  VALID: 'VALID',
  INVALID: 'INVALID',
  BLOCKED: 'BLOCKED',
  ERROR: 'ERROR',
};

/**
 * Batch processing states.
 */
const BATCH_STATES = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  ABORTED: 'ABORTED',
  FAILED: 'FAILED',
};

module.exports = {
  STATUS_CODES,
  BATCH_STATES,
};
