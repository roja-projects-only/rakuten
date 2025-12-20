const fs = require('fs').promises;
const path = require('path');
const { createLogger } = require('../../logger');

const log = createLogger('processed-store');

const DEFAULT_TTL_MS = parseInt(process.env.PROCESSED_TTL_MS, 10) || 7 * 24 * 60 * 60 * 1000;
const STORE_PATH = path.join(process.cwd(), 'data', 'processed', 'processed-creds.jsonl');

// New key format: proc:{STATUS}:{email}:{password}
// This makes status visible in Redis key listings (e.g., Railway dashboard)
const REDIS_PREFIX = 'proc:';
const STATUSES = ['VALID', 'INVALID', 'BLOCKED', 'ERROR'];

// Storage backend: 'redis' or 'jsonl'
let backend = null;
let redisClient = null;
let initialized = false;
const cache = new Map(); // Used for JSONL backend

// ============ Write Buffer for Redis Pipeline ============
const writeBuffer = [];
const WRITE_BUFFER_SIZE = 100; // Flush every 100 writes
const WRITE_BUFFER_INTERVAL_MS = 1000; // Or every 1 second
let writeBufferTimer = null;
let flushPromise = null;

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

// ============ JSONL Backend ============

async function ensureFile() {
  const dir = path.dirname(STORE_PATH);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.access(STORE_PATH);
  } catch (_) {
    await fs.writeFile(STORE_PATH, '', 'utf8');
  }
}

async function rewriteFile() {
  const lines = [];
  for (const [key, entry] of cache.entries()) {
    lines.push(JSON.stringify({ key, status: entry.status, ts: entry.ts }));
  }
  await fs.writeFile(STORE_PATH, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
}

async function hydrateJsonl(ttlMs) {
  await ensureFile();
  const text = await fs.readFile(STORE_PATH, 'utf8').catch(() => '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const now = Date.now();
  let pruned = false;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (!parsed || !parsed.key || !parsed.status || !parsed.ts) continue;
      if (now - parsed.ts > ttlMs) {
        pruned = true;
        continue;
      }
      cache.set(parsed.key, { status: parsed.status, ts: parsed.ts });
    } catch (_) {
      pruned = true;
    }
  }

  if (pruned) {
    await rewriteFile();
  }
}


// ============ Redis Backend ============

async function initRedis() {
  const Redis = require('ioredis');
  const url = process.env.REDIS_URL;
  
  redisClient = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 100,
    lazyConnect: true,
  });
  
  redisClient.on('error', (err) => {
    log.warn(`Redis error: ${err.message}`);
  });
  
  await redisClient.connect();
  log.info('Redis connected');
}

/**
 * Flushes the write buffer to Redis using pipeline (single round-trip).
 * @returns {Promise<void>}
 */
async function flushWriteBuffer() {
  if (writeBuffer.length === 0 || backend !== 'redis' || !redisClient) {
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

// ============ Unified Interface ============

async function initProcessedStore(ttlMs = DEFAULT_TTL_MS) {
  if (initialized) return;
  
  if (process.env.REDIS_URL) {
    try {
      await initRedis();
      backend = 'redis';
      log.info('Using Redis backend for processed store');
    } catch (err) {
      log.warn(`Redis init failed: ${err.message}, falling back to JSONL`);
      backend = 'jsonl';
      await hydrateJsonl(ttlMs);
    }
  } else {
    backend = 'jsonl';
    await hydrateJsonl(ttlMs);
    log.info('Using JSONL backend for processed store');
  }
  
  initialized = true;
}

async function getProcessedStatus(key, ttlMs = DEFAULT_TTL_MS) {
  await initProcessedStore(ttlMs);
  
  if (backend === 'redis') {
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
  
  // JSONL backend
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttlMs) return null;
  return entry.status;
}

/**
 * Batch lookup for multiple keys - much faster than individual lookups.
 * Uses Redis MGET for batch operations.
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
  
  if (backend === 'redis') {
    try {
      const BATCH_SIZE = 250; // Smaller batches since we query 4 keys per credential
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
        
        const values = await redisClient.mget(...redisKeys);
        
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
          const oldValues = await redisClient.mget(...oldKeys);
          
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
        if (totalBatches > 10 && (i / BATCH_SIZE) % 10 === 0) {
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
  
  // JSONL backend - iterate cache
  const now = Date.now();
  for (const key of keys) {
    const entry = cache.get(key);
    if (!entry) {
      results.set(key, null);
    } else if (now - entry.ts > ttlMs) {
      results.set(key, null);
    } else {
      results.set(key, entry.status);
    }
  }
  
  return results;
}

async function markProcessedStatus(key, status, ttlMs = DEFAULT_TTL_MS) {
  await initProcessedStore(ttlMs);
  const ts = Date.now();
  
  if (backend === 'redis') {
    const ttlSeconds = Math.ceil(ttlMs / 1000);
    
    // Add to write buffer instead of immediate write
    writeBuffer.push({ key, status, ts, ttlSeconds });
    
    // Flush if buffer is full, otherwise schedule a flush
    if (writeBuffer.length >= WRITE_BUFFER_SIZE) {
      await flushWriteBuffer();
    } else {
      scheduleFlush();
    }
    return;
  }
  
  // JSONL backend
  cache.set(key, { status, ts });
  try {
    await fs.appendFile(STORE_PATH, `${JSON.stringify({ key, status, ts })}\n`, 'utf8');
  } catch (err) {
    log.warn(`Unable to append processed status: ${err.message}`);
  }
}

async function pruneExpired(ttlMs = DEFAULT_TTL_MS) {
  await initProcessedStore(ttlMs);
  
  // Redis handles TTL automatically via SETEX
  if (backend === 'redis') return;
  
  // JSONL backend
  const now = Date.now();
  let pruned = false;

  for (const [key, entry] of cache.entries()) {
    if (now - entry.ts > ttlMs) {
      cache.delete(key);
      pruned = true;
    }
  }

  if (pruned) {
    await rewriteFile();
  }
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
};
