/**
 * Redis Key Schema Constants
 * 
 * Centralized key generation for the distributed worker architecture.
 * Based on Appendix B from the design document.
 */

/**
 * Task lease tracking keys
 * Pattern: job:{batchId}:{taskId}
 * TTL: 5 minutes
 * Purpose: Track active task leases to detect zombie tasks
 */
const TASK_LEASE = {
  pattern: 'job:{batchId}:{taskId}',
  generate: (batchId, taskId) => `job:${batchId}:${taskId}`,
  ttl: 5 * 60 // 5 minutes in seconds
};

/**
 * Result deduplication cache keys
 * Pattern: result:{status}:{email}:{password}
 * TTL: 30 days
 * Purpose: Store credential check results for deduplication
 */
const RESULT_CACHE = {
  pattern: 'result:{status}:{email}:{password}',
  generate: (status, email, password) => `result:${status}:${email}:${password}`,
  ttl: 30 * 24 * 60 * 60 // 30 days in seconds
};

/**
 * Capture summary keys (VALID only for now)
 * Pattern: cap:{status}:{email}:{password}
 * TTL: aligns with processed creds TTL (configured in worker)
 * Purpose: Store trimmed capture summaries for dashboard/API consumption
 */
const CAPTURE_SUMMARY = {
  pattern: 'cap:{status}:{email}:{password}',
  generate: (status, email, password) => `cap:${status}:${email}:${password}`
};

/**
 * Batch progress tracking keys
 * Pattern: progress:{batchId}
 * TTL: 7 days
 * Purpose: Track batch completion progress for Telegram updates
 */
const PROGRESS_TRACKER = {
  pattern: 'progress:{batchId}',
  generate: (batchId) => `progress:${batchId}`,
  counterPattern: 'progress:{batchId}:count',
  generateCounter: (batchId) => `progress:${batchId}:count`,
  countsPattern: 'progress:{batchId}:counts',
  generateCounts: (batchId) => `progress:${batchId}:counts`,
  validCredsPattern: 'progress:{batchId}:valid',
  generateValidCreds: (batchId) => `progress:${batchId}:valid`,
  ttl: 7 * 24 * 60 * 60 // 7 days in seconds
};

/**
 * Proxy health state keys
 * Pattern: proxy:{proxyId}:health
 * TTL: 5 minutes (for unhealthy proxies)
 * Purpose: Track proxy health and consecutive failures
 */
const PROXY_HEALTH = {
  pattern: 'proxy:{proxyId}:health',
  generate: (proxyId) => `proxy:${proxyId}:health`,
  ttl: 5 * 60 // 5 minutes in seconds
};

/**
 * Channel message tracking keys
 * Pattern: msg:{trackingCode}
 * TTL: 30 days
 * Purpose: Track forwarded Telegram channel messages for updates/deletion
 */
const MESSAGE_TRACKING = {
  pattern: 'msg:{trackingCode}',
  generate: (trackingCode) => `msg:${trackingCode}`,
  reversePattern: 'msg:cred:{email}:{password}',
  generateReverse: (email, password) => `msg:cred:${email}:${password}`,
  ttl: 30 * 24 * 60 * 60 // 30 days in seconds
};

/**
 * Coordinator heartbeat keys
 * Pattern: coordinator:heartbeat
 * TTL: 30 seconds
 * Purpose: High availability coordinator failover detection
 */
const COORDINATOR_HEARTBEAT = {
  pattern: 'coordinator:heartbeat',
  key: 'coordinator:heartbeat',
  ttl: 30 // 30 seconds
};

/**
 * Distributed operation lock keys
 * Pattern: coordinator:lock:{operation}
 * TTL: 10 seconds
 * Purpose: Prevent duplicate operations across multiple coordinators
 */
const COORDINATOR_LOCK = {
  pattern: 'coordinator:lock:{operation}',
  generate: (operation) => `coordinator:lock:${operation}`,
  ttl: 10 // 10 seconds
};

/**
 * Worker heartbeat keys
 * Pattern: worker:{workerId}:heartbeat
 * TTL: 30 seconds
 * Purpose: Track worker liveness for dead worker detection
 */
const WORKER_HEARTBEAT = {
  pattern: 'worker:{workerId}:heartbeat',
  generate: (workerId) => `worker:${workerId}:heartbeat`,
  ttl: 30 // 30 seconds
};

/**
 * Two-phase commit pending state keys
 * Pattern: forward:pending:{trackingCode}
 * TTL: 2 minutes
 * Purpose: Track pending channel forwards for crash recovery
 */
const FORWARD_PENDING = {
  pattern: 'forward:pending:{trackingCode}',
  generate: (trackingCode) => `forward:pending:${trackingCode}`,
  ttl: 2 * 60 // 2 minutes in seconds
};

/**
 * POW service cache keys
 * Pattern: pow:{mask}:{key}:{seed}
 * TTL: 5 minutes
 * Purpose: Cache computed cres values to avoid recomputation
 */
const POW_CACHE = {
  pattern: 'pow:{mask}:{key}:{seed}',
  generate: (mask, key, seed) => `pow:${mask}:${key}:${seed}`,
  ttl: 5 * 60 // 5 minutes in seconds
};

/**
 * Job queue keys
 * Pattern: queue:tasks, queue:retry
 * Type: LIST
 * Purpose: FIFO task distribution to workers
 */
const JOB_QUEUE = {
  tasks: 'queue:tasks',
  retry: 'queue:retry'
};

/**
 * Pub/Sub channel names
 */
const PUBSUB_CHANNELS = {
  forwardEvents: 'forward_events',
  updateEvents: 'update_events',
  workerHeartbeats: 'worker_heartbeats'
};

/**
 * Key pattern matchers for scanning operations
 */
const KEY_PATTERNS = {
  allTaskLeases: 'job:*',
  allProgressTrackers: 'progress:*',
  allProxyHealth: 'proxy:*:health',
  allWorkerHeartbeats: 'worker:*:heartbeat',
  allForwardPending: 'forward:pending:*',
  allMessageTracking: 'msg:*',
  allPowCache: 'pow:*',
  allResults: 'result:*'
};

/**
 * Generate a unique batch ID
 */
function generateBatchId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${random}`;
}

/**
 * Generate a unique task ID within a batch
 */
function generateTaskId(batchId, index) {
  return `${batchId}-${String(index).padStart(4, '0')}`;
}

/**
 * Generate a unique worker ID
 */
function generateWorkerId() {
  const hostname = process.env.HOSTNAME || 'worker';
  const pid = process.pid;
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return `${hostname}-${pid}-${timestamp}-${random}`;
}

/**
 * Generate tracking code for channel messages
 * Format: RK-XXXXXXXX (8 hex chars from credential hash)
 */
function generateTrackingCode(username, password) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256')
    .update(`${username}:${password}`)
    .digest('hex');
  return `RK-${hash.substring(0, 8).toUpperCase()}`;
}

/**
 * Parse batch ID to extract timestamp
 */
function parseBatchId(batchId) {
  const [timestampPart] = batchId.split('-');
  const timestamp = parseInt(timestampPart, 36);
  return {
    timestamp,
    date: new Date(timestamp),
    age: Date.now() - timestamp
  };
}

/**
 * Validate key format against pattern
 */
function validateKey(key, pattern) {
  // Convert pattern to regex
  const regexPattern = pattern
    .replace(/\{[^}]+\}/g, '([^:]+)')
    .replace(/\*/g, '.*');
  
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(key);
}

/**
 * Extract components from a key using pattern
 */
function parseKey(key, pattern) {
  const parts = pattern.split(':');
  const keyParts = key.split(':');
  
  if (parts.length !== keyParts.length) {
    return null;
  }
  
  const result = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith('{') && part.endsWith('}')) {
      const fieldName = part.slice(1, -1);
      result[fieldName] = keyParts[i];
    }
  }
  
  return result;
}

module.exports = {
  // Key generators
  TASK_LEASE,
  RESULT_CACHE,
  CAPTURE_SUMMARY,
  PROGRESS_TRACKER,
  PROXY_HEALTH,
  MESSAGE_TRACKING,
  COORDINATOR_HEARTBEAT,
  COORDINATOR_LOCK,
  WORKER_HEARTBEAT,
  FORWARD_PENDING,
  POW_CACHE,
  JOB_QUEUE,
  PUBSUB_CHANNELS,
  KEY_PATTERNS,
  
  // Utility functions
  generateBatchId,
  generateTaskId,
  generateWorkerId,
  generateTrackingCode,
  parseBatchId,
  validateKey,
  parseKey
};