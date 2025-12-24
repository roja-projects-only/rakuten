/**
 * =============================================================================
 * CHANNEL FORWARD STORE - Deduplication for channel forwarding
 * =============================================================================
 * 
 * Tracks which credentials have been forwarded to the channel to ensure
 * each VALID credential is only sent once (even if .chk is run again).
 * 
 * Uses Redis with `fwd:` prefix keys, or JSONL file as fallback.
 * 
 * =============================================================================
 */

const fs = require('fs').promises;
const path = require('path');
const { createLogger } = require('../logger');

const log = createLogger('forward-store');

const DEFAULT_TTL_MS = parseInt(process.env.FORWARD_TTL_MS, 10) || 30 * 24 * 60 * 60 * 1000; // 30 days
const STORE_PATH = path.join(process.cwd(), 'data', 'processed', 'forwarded-creds.jsonl');
const REDIS_PREFIX = 'fwd:';

// Storage backend: 'redis' or 'jsonl'
let backend = null;
let redisClient = null;
let initialized = false;
const cache = new Map(); // Used for JSONL backend

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

async function hydrateJsonl(ttlMs) {
  await ensureFile();
  const text = await fs.readFile(STORE_PATH, 'utf8').catch(() => '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const now = Date.now();
  let pruned = false;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (!parsed || !parsed.key || !parsed.ts) continue;
      if (now - parsed.ts > ttlMs) {
        pruned = true;
        continue;
      }
      cache.set(parsed.key, parsed.ts);
    } catch (_) {
      pruned = true;
    }
  }

  if (pruned) {
    await rewriteFile();
  }
}

async function rewriteFile() {
  const lines = [];
  for (const [key, ts] of cache.entries()) {
    lines.push(JSON.stringify({ key, ts }));
  }
  await fs.writeFile(STORE_PATH, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
}

async function removeFromFile(key) {
  const removed = cache.delete(key);
  if (removed) {
    await rewriteFile();
  }
  return removed;
}

// ============ Redis Backend ============

async function initRedis() {
  // Try to reuse existing Redis client from processedStore
  try {
    const { getRedisClient, isRedisBackend } = require('../automation/batch/processedStore');
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

// ============ Unified Interface ============

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

  if (process.env.REDIS_URL) {
    try {
      await initRedis();
      backend = 'redis';
      log.info('Using Redis backend for forward store');
    } catch (err) {
      log.warn(`Redis init failed: ${err.message}, falling back to JSONL`);
      backend = 'jsonl';
      await hydrateJsonl(ttlMs);
    }
  } else {
    backend = 'jsonl';
    await hydrateJsonl(ttlMs);
    log.info('Using JSONL backend for forward store');
  }

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

  if (backend === 'redis') {
    try {
      const redisKey = `${REDIS_PREFIX}${key}`;
      const exists = await redisClient.exists(redisKey);
      return exists === 1;
    } catch (err) {
      log.warn(`Redis exists error: ${err.message}`);
      return false;
    }
  }

  // JSONL backend
  const ts = cache.get(key);
  if (!ts) return false;
  if (Date.now() - ts > ttlMs) return false;
  return true;
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

  if (backend === 'redis') {
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

  // JSONL backend (single-process best-effort)
  const existing = cache.get(key);
  if (existing && ts - existing <= ttlMs) return false;
  cache.set(key, ts);
  await rewriteFile();
  return true;
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

  if (backend === 'redis') {
    try {
      const redisKey = `${REDIS_PREFIX}${key}`;
      const deleted = await redisClient.del(redisKey);
      return deleted === 1;
    } catch (err) {
      log.warn(`Redis release error: ${err.message}`);
      return false;
    }
  }

  return removeFromFile(key);
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

  if (backend === 'redis') {
    try {
      const redisKey = `${REDIS_PREFIX}${key}`;
      const ttlSeconds = Math.ceil(ttlMs / 1000);
      await redisClient.setex(redisKey, ttlSeconds, String(ts));
      log.debug(`Marked forwarded: ${username.slice(0, 5)}***`);
    } catch (err) {
      log.warn(`Redis setex error: ${err.message}`);
    }
    return;
  }

  // JSONL backend
  cache.set(key, ts);
  try {
    await fs.appendFile(STORE_PATH, `${JSON.stringify({ key, ts })}\n`, 'utf8');
  } catch (err) {
    log.warn(`Unable to append forwarded status: ${err.message}`);
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
