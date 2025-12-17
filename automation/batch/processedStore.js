const fs = require('fs').promises;
const path = require('path');
const { createLogger } = require('../../logger');

const log = createLogger('processed-store');

const DEFAULT_TTL_MS = parseInt(process.env.PROCESSED_TTL_MS, 10) || 7 * 24 * 60 * 60 * 1000;
const STORE_PATH = path.join(process.cwd(), 'data', 'processed', 'processed-creds.jsonl');
const REDIS_PREFIX = 'proc:';

// Storage backend: 'redis' or 'jsonl'
let backend = null;
let redisClient = null;
let initialized = false;
const cache = new Map(); // Used for JSONL backend

function isSkippableStatus(status) {
  if (!status) return false;
  const upper = String(status).toUpperCase();
  return upper === 'VALID' || upper === 'INVALID' || upper === 'BLOCKED';
}

function makeKey(username, password) {
  return `${username}:${password}`;
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
      const data = await redisClient.get(`${REDIS_PREFIX}${key}`);
      if (!data) return null;
      const parsed = JSON.parse(data);
      return parsed.status;
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

async function markProcessedStatus(key, status, ttlMs = DEFAULT_TTL_MS) {
  await initProcessedStore(ttlMs);
  const ts = Date.now();
  
  if (backend === 'redis') {
    try {
      const ttlSeconds = Math.ceil(ttlMs / 1000);
      await redisClient.setex(
        `${REDIS_PREFIX}${key}`,
        ttlSeconds,
        JSON.stringify({ status, ts })
      );
    } catch (err) {
      log.warn(`Redis set error: ${err.message}`);
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
  markProcessedStatus,
  pruneExpired,
  isSkippableStatus,
  makeKey,
  closeStore,
};
