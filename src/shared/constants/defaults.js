/**
 * Redis key prefixes and TTL defaults.
 * Centralized here to avoid duplication across modules.
 */
const DEFAULTS = {
  PROCESSED_TTL_MS: 30 * 24 * 60 * 60 * 1000, // 30 days
  FORWARD_TTL_MS: 30 * 24 * 60 * 60 * 1000,    // 30 days
  TASK_LEASE_TTL_S: 5 * 60,                      // 5 minutes
  COORDINATOR_HEARTBEAT_TTL_S: 30,                // 30 seconds
  WORKER_HEARTBEAT_TTL_S: 30,                     // 30 seconds
  POW_CACHE_TTL_S: 5 * 60,                        // 5 minutes
  PROGRESS_TTL_S: 7 * 24 * 60 * 60,               // 7 days
};

module.exports = { DEFAULTS };
