/**
 * Processed Store — Redis-only credential deduplication
 * 
 * Tracks which credentials have been processed (VALID/INVALID/BLOCKED/ERROR)
 * to avoid re-checking credentials across batches.
 * 
 * Redis is the only supported backend. If Redis is unavailable, operations
 * will fail with clear errors rather than silently falling back.
 */

const { createLogger } = require('../logger');

const log = createLogger('processed-store');

const DEFAULT_TTL_MS = parseInt(process.env.PROCESSED_TTL_MS, 10) || 30 * 24 * 60 * 60 * 1000; // 30 days

// New key format: proc:{STATUS}:{email}:{password}
// This makes status visible in Redis key listings (e.g., Railway dashboard)
const REDIS_PREFIX = 'proc:';
const STATUSES = ['VALID', 'INVALID', 'BLOCKED', 'ERROR'];

let redisClient = null;
let initialized = false;

// ============ Write Buffer for Redis Pipeline ============
const writeBuffer = [];
const WRITE_BUFFER_SIZE = 100; // Flush every 100 writes
const WRITE_BUFFER_INTERVAL_MS = 1000; // Or every 1 second
let writeBufferTimer = null;

function isSkippableStatus(status) {
  if (!status) return false;
  const upper = String(status).toUpperCase();
  return upper === 'VALID' || upper === 'INVALID' || upper === 'BLOCKED';
}

function makeKey(username, password) {
  return `${username}:${password}`;
}

/**
 * Make Redis key with status prefix for visibility.
 * Format: proc:{STATUS}:{email}:{password}
 */
function makeRedisKey(credKey, status) {
  return `${REDIS_PREFIX}${status.toUpperCase()}:${credKey}`;
}

/**
 * Get all possible Redis keys for a credential (all statuses).
 * Used for lookup when we don't know the status.
 */
function getAllPossibleRedisKeys(credKey) {
  return STATUSES.map(status => makeRedisKey(credKey, status));
}

// ============ Redis Backend ============

async function initRedis() {
  const Redis = require('ioredis');
  const url = process.env.REDIS_URL;
  
  if (!url) {
    throw new Error('REDIS_URL is required for processed store. Redis is the only supported backend.');
  }
  
  redisClient = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 100,
    lazyConnect: true,
  });
  
  redisClient.on('error', (err) => {
    log.warn(`Redis error: ${err.message}`);
  });
  
  await redisClient.connect();
  log.info('Redis connected for processed store');
}

/**
 * Flushes the write buffer to Redis using pipeline (single round-trip).
 * @returns {Promise<void>}
 */
async function flushWriteBuffer() {
  if (writeBuffer.length === 0 || !redisClient) {
    return;
  }
  
  // Clear timer if running
  if (writeBufferTimer) {
    clearTimeout(writeBufferTimer);
    writeBufferTimer = null;
  }
  
  // Take all items from buffer
  const items = writeBuffer.splice(0, writeBuffer.length);
  if (items.length === 0) return;
  
  try {
    // Use pipeline for batch writes - single round-trip for all
    const pipeline = redisClient.pipeline();
    for (const { key, status, ts, ttlSeconds } of items) {
      // New key format: proc:{STATUS}:{email}:{password}
      // Value is just the timestamp (status is in the key)
      const redisKey = makeRedisKey(key, status);
      pipeline.setex(redisKey, ttlSeconds, String(ts));
    }
    await pipeline.exec();
    log.debug(`Flushed ${items.length} writes to Redis`);
  } catch (err) {
    log.warn(`Redis pipeline flush error: ${err.message}`);
  }
}

/**
 * Schedules a buffer flush after the interval.
 */
function scheduleFlush() {
  if (writeBufferTimer) return; // Already scheduled
  
  writeBufferTimer = setTimeout(async () => {
    writeBufferTimer = null;
    await flushWriteBuffer();
  }, WRITE_BUFFER_INTERVAL_MS);
}

// ============ Interface ============

async function initProcessedStore(ttlMs = DEFAULT_TTL_MS) {
  if (initialized) return;
  
  if (!process.env.REDIS_URL) {
    throw new Error('REDIS_URL is required for processed store. Set REDIS_URL environment variable.');
  }
  
  await initRedis();
  log.info('Processed store initialized (Redis-only)');
  initialized = true;
}

async function getProcessedStatus(key, ttlMs = DEFAULT_TTL_MS) {
  await initProcessedStore(ttlMs);
  
  try {
    // Check all possible status keys using MGET
    const possibleKeys = getAllPossibleRedisKeys(key);
    const values = await redisClient.mget(...possibleKeys);
    
    // Find which status key exists
    for (let i = 0; i < STATUSES.length; i++) {
      if (values[i]) {
        return STATUSES[i];
      }
    }
    
    // Fallback: check old format key for migration
    const oldKey = `${REDIS_PREFIX}${key}`;
    const oldData = await redisClient.get(oldKey);
    if (oldData) {
      try {
        const parsed = JSON.parse(oldData);
        return parsed.status;
      } catch (_) {
        return null;
      }
    }
    
    return null;
  } catch (err) {
    log.warn(`Redis get error: ${err.message}`);
    return null;
  }
}

/**
 * Batch lookup for multiple keys - much faster than individual lookups.
 * Uses Redis MGET for batch operations with optimized key checking.
 * New format checks: proc:{STATUS}:{email}:{password} for all statuses
 * Also checks old format: proc:{email}:{password} for migration
 * @param {string[]} keys - Array of keys to lookup
 * @param {number} ttlMs - TTL in milliseconds
 * @returns {Promise<Map<string, string|null>>} Map of key -> status
 */
async function getProcessedStatusBatch(keys, ttlMs = DEFAULT_TTL_MS) {
  await initProcessedStore(ttlMs);
  
  const results = new Map();
  
  if (!keys.length) return results;
  
  try {
    const BATCH_SIZE = 1000; // Increased from 250 to 1000 for better performance
    const totalBatches = Math.ceil(keys.length / BATCH_SIZE);
    
    log.info(`Checking ${keys.length} keys against Redis (${totalBatches} batches)...`);
    
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const batch = keys.slice(i, i + BATCH_SIZE);
      
      // Build all possible Redis keys for this batch (4 per credential: VALID, INVALID, BLOCKED, ERROR)
      const redisKeys = [];
      const keyIndexMap = []; // Maps redis key index to [credKey, status]
      
      for (const credKey of batch) {
        for (const status of STATUSES) {
          redisKeys.push(makeRedisKey(credKey, status));
          keyIndexMap.push({ credKey, status });
        }
      }
      
      // Use pipeline for even better performance on large batches
      let values;
      if (redisKeys.length > 2000) {
        const pipeline = redisClient.pipeline();
        pipeline.mget(...redisKeys);
        const results = await pipeline.exec();
        values = results[0][1]; // Get the mget result from pipeline
      } else {
        values = await redisClient.mget(...redisKeys);
      }
      
      // Process results - find first matching status for each credential
      const foundStatus = new Map();
      for (let j = 0; j < values.length; j++) {
        if (values[j] && !foundStatus.has(keyIndexMap[j].credKey)) {
          foundStatus.set(keyIndexMap[j].credKey, keyIndexMap[j].status);
        }
      }
      
      // Check old format for keys not found in new format (migration support)
      const notFound = batch.filter(k => !foundStatus.has(k));
      if (notFound.length > 0) {
        const oldKeys = notFound.map(k => `${REDIS_PREFIX}${k}`);
        let oldValues;
        
        if (oldKeys.length > 500) {
          const pipeline = redisClient.pipeline();
          pipeline.mget(...oldKeys);
          const results = await pipeline.exec();
          oldValues = results[0][1];
        } else {
          oldValues = await redisClient.mget(...oldKeys);
        }
        
        for (let j = 0; j < notFound.length; j++) {
          if (oldValues[j]) {
            try {
              const parsed = JSON.parse(oldValues[j]);
              if (parsed.status) {
                foundStatus.set(notFound[j], parsed.status);
              }
            } catch (_) {}
          }
        }
      }
      
      // Set results
      for (const credKey of batch) {
        results.set(credKey, foundStatus.get(credKey) || null);
      }
      
      // Log progress for large batches
      if (totalBatches > 5 && (i / BATCH_SIZE) % 5 === 0) {
        log.debug(`Redis MGET progress: ${Math.floor(i / BATCH_SIZE) + 1}/${totalBatches} batches`);
      }
    }
    
    log.info(`Redis lookup complete: ${keys.length} keys checked`);
    return results;
  } catch (err) {
    log.warn(`Redis MGET error: ${err.message}`);
    // Fall through to return empty results
    return results;
  }
}

async function markProcessedStatus(key, status, ttlMs = DEFAULT_TTL_MS) {
  await initProcessedStore(ttlMs);
  const ts = Date.now();
  const ttlSeconds = Math.ceil(ttlMs / 1000);
  
  // Add to write buffer instead of immediate write
  writeBuffer.push({ key, status, ts, ttlSeconds });
  
  // Flush if buffer is full, otherwise schedule a flush
  if (writeBuffer.length >= WRITE_BUFFER_SIZE) {
    await flushWriteBuffer();
  } else {
    scheduleFlush();
  }
}

async function pruneExpired(ttlMs = DEFAULT_TTL_MS) {
  // Redis handles TTL automatically via SETEX
  // This function is a no-op for Redis-only mode
  await initProcessedStore(ttlMs);
}

async function closeStore() {
  // Flush any pending writes before closing
  await flushWriteBuffer();
  
  if (writeBufferTimer) {
    clearTimeout(writeBufferTimer);
    writeBufferTimer = null;
  }
  
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    log.info('Redis disconnected');
  }
}

/**
 * Get the Redis client instance (for export functionality).
 * @returns {Object|null} Redis client or null if not initialized
 */
function getRedisClient() {
  return redisClient;
}

/**
 * Check if Redis backend is active.
 * @returns {boolean}
 */
function isRedisBackend() {
  return redisClient !== null;
}

module.exports = {
  DEFAULT_TTL_MS,
  initProcessedStore,
  getProcessedStatus,
  getProcessedStatusBatch,
  markProcessedStatus,
  flushWriteBuffer,
  pruneExpired,
  isSkippableStatus,
  makeKey,
  closeStore,
  getRedisClient,
  isRedisBackend,
};
