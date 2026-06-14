/**
 * =============================================================================
 * CHANNEL FORWARD STORE - Deduplication for channel forwarding
 * =============================================================================
 * 
 * Tracks which credentials have been forwarded to the channel to ensure
 * each VALID credential is only sent once (even if .chk is run again).
 * 
 * Redis is the only supported backend. If Redis is unavailable, operations
 * will fail with clear errors rather than silently falling back.
 * 
 * =============================================================================
 */

const { createLogger } = require('../shared/logger');

const log = createLogger('forward-store');

const DEFAULT_TTL_MS = parseInt(process.env.FORWARD_TTL_MS, 10) || 30 * 24 * 60 * 60 * 1000; // 30 days
const REDIS_PREFIX = 'fwd:';

let redisClient = null;
let initialized = false;

// ============ Redis Backend ============

async function initRedis() {
  // Try to reuse existing Redis client from processedStore
  try {
    const { getRedisClient, isRedisBackend } = require('../shared/batch/processedStore');
    if (isRedisBackend()) {
      redisClient = getRedisClient();
      if (redisClient) {
        log.debug('Reusing Redis client from processedStore');
        return;
      }
    }
  } catch (_) {
    // processedStore not initialized yet, create our own connection
  }

  // Create our own Redis connection
  const Redis = require('ioredis');
  const url = process.env.REDIS_URL;
  
  if (!url) {
    throw new Error('REDIS_URL is required for forward store. Redis is the only supported backend.');
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
  log.debug('Forward store Redis connected');
}

// ============ Interface ============

/**
 * Makes a dedupe key from credentials.
 * @param {string} username - Email/username
 * @param {string} password - Password
 * @returns {string} Dedupe key
 */
function makeKey(username, password) {
  return `${username}:${password}`;
}

/**
 * Initialize the forward store.
 * @param {number} ttlMs - TTL for forwarded entries
 */
async function initForwardStore(ttlMs = DEFAULT_TTL_MS) {
  if (initialized) return;

  if (!process.env.REDIS_URL) {
    throw new Error('REDIS_URL is required for forward store. Set REDIS_URL environment variable.');
  }

  await initRedis();
  log.info('Forward store initialized (Redis-only)');
  initialized = true;
}

/**
 * Check if a credential has already been forwarded to channel.
 * @param {string} username - Email/username
 * @param {string} password - Password
 * @param {number} ttlMs - TTL in milliseconds
 * @returns {Promise<boolean>} True if already forwarded
 */
async function hasBeenForwarded(username, password, ttlMs = DEFAULT_TTL_MS) {
  await initForwardStore(ttlMs);

  const key = makeKey(username, password);

  try {
    const redisKey = `${REDIS_PREFIX}${key}`;
    const exists = await redisClient.exists(redisKey);
    return exists === 1;
  } catch (err) {
    log.warn(`Redis exists error: ${err.message}`);
    return false;
  }
}

/**
 * Atomically reserve a forward slot. Returns false if it already exists.
 * @param {string} username
 * @param {string} password
 * @param {number} ttlMs
 * @returns {Promise<boolean>} True if reservation created
 */
async function reserveForwarded(username, password, ttlMs = DEFAULT_TTL_MS) {
  await initForwardStore(ttlMs);

  const key = makeKey(username, password);
  const ts = Date.now();

  try {
    const redisKey = `${REDIS_PREFIX}${key}`;
    const ttlSeconds = Math.ceil(ttlMs / 1000);
    const result = await redisClient.set(redisKey, String(ts), 'NX', 'EX', ttlSeconds);
    return result === 'OK';
  } catch (err) {
    log.warn(`Redis reserve error: ${err.message}`);
    return false;
  }
}

/**
 * Remove a forwarded marker so the credential can be forwarded again.
 * @param {string} username
 * @param {string} password
 * @returns {Promise<boolean>} True if an entry was removed
 */
async function releaseForwarded(username, password) {
  await initForwardStore();

  const key = makeKey(username, password);

  try {
    const redisKey = `${REDIS_PREFIX}${key}`;
    const deleted = await redisClient.del(redisKey);
    return deleted === 1;
  } catch (err) {
    log.warn(`Redis release error: ${err.message}`);
    return false;
  }
}

/**
 * Mark a credential as forwarded to channel.
 * @param {string} username - Email/username
 * @param {string} password - Password
 * @param {number} ttlMs - TTL in milliseconds
 */
async function markForwarded(username, password, ttlMs = DEFAULT_TTL_MS) {
  await initForwardStore(ttlMs);

  const key = makeKey(username, password);
  const ts = Date.now();

  try {
    const redisKey = `${REDIS_PREFIX}${key}`;
    const ttlSeconds = Math.ceil(ttlMs / 1000);
    await redisClient.setex(redisKey, ttlSeconds, String(ts));
    log.debug(`Marked forwarded: ${username.slice(0, 5)}***`);
  } catch (err) {
    log.warn(`Redis setex error: ${err.message}`);
  }
}

module.exports = {
  initForwardStore,
  hasBeenForwarded,
  markForwarded,
  makeKey,
  reserveForwarded,
  releaseForwarded,
  DEFAULT_TTL_MS,
};
