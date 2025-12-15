const fs = require('fs').promises;
const path = require('path');
const { createLogger } = require('../../logger');

const log = createLogger('processed-store');

const DEFAULT_TTL_MS = parseInt(process.env.PROCESSED_TTL_MS, 10) || 7 * 24 * 60 * 60 * 1000;
const STORE_PATH = path.join(process.cwd(), 'data', 'processed', 'processed-creds.jsonl');

let initialized = false;
const cache = new Map();

async function ensureFile() {
  const dir = path.dirname(STORE_PATH);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.access(STORE_PATH);
  } catch (_) {
    await fs.writeFile(STORE_PATH, '', 'utf8');
  }
}

function isSkippableStatus(status) {
  if (!status) return false;
  const upper = String(status).toUpperCase();
  return upper === 'VALID' || upper === 'INVALID' || upper === 'BLOCKED';
}

async function rewriteFile() {
  const lines = [];
  for (const [key, entry] of cache.entries()) {
    lines.push(JSON.stringify({ key, status: entry.status, ts: entry.ts }));
  }
  await fs.writeFile(STORE_PATH, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
}

async function hydrate(ttlMs) {
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

async function initProcessedStore(ttlMs = DEFAULT_TTL_MS) {
  if (initialized) return;
  await hydrate(ttlMs);
  initialized = true;
}

function getProcessedStatus(key, ttlMs = DEFAULT_TTL_MS) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttlMs) return null;
  return entry.status;
}

async function markProcessedStatus(key, status, ttlMs = DEFAULT_TTL_MS) {
  await initProcessedStore(ttlMs);
  const ts = Date.now();
  cache.set(key, { status, ts });
  try {
    await fs.appendFile(STORE_PATH, `${JSON.stringify({ key, status, ts })}\n`, 'utf8');
  } catch (err) {
    log.warn(`Unable to append processed status: ${err.message}`);
  }
}

async function pruneExpired(ttlMs = DEFAULT_TTL_MS) {
  await initProcessedStore(ttlMs);
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

function makeKey(username, password) {
  return `${username}:${password}`;
}

module.exports = {
  DEFAULT_TTL_MS,
  initProcessedStore,
  getProcessedStatus,
  markProcessedStatus,
  pruneExpired,
  isSkippableStatus,
  makeKey,
};
