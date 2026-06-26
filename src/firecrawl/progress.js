// LOCAL-ONLY: not for production services.
// @ts-check

'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../shared/logger');

const log = createLogger('firecrawl:progress');

/**
 * Absolute path to the API scrape progress JSON file.
 * @type {string}
 */
const PROGRESS_FILE = path.resolve(__dirname, '..', '..', 'docs', 'api-scrape-progress.json');

/**
 * Load progress state from disk.
 *
 * Reads and parses the progress JSON file. Returns `null` if the file does
 * not exist or if the JSON is malformed (a warning is logged in that case).
 *
 * @returns {object|null} The parsed progress state, or null.
 */
function loadProgress() {
  try {
    const raw = fs.readFileSync(PROGRESS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    log.warn('Progress file corrupted, starting fresh');
    return null;
  }
}

/**
 * Save progress state to disk.
 *
 * Sets `state.last_updated` to the current ISO timestamp, ensures the
 * `docs/` directory exists, and writes the state as pretty-printed JSON
 * (2-space indent).
 *
 * @param {object} state - The progress state object to persist.
 * @returns {void}
 */
function saveProgress(state) {
  state.last_updated = new Date().toISOString();

  const dir = path.dirname(PROGRESS_FILE);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(state, null, 2), 'utf8');

  const bc = state.batches_completed ?? 0;
  const ef = Array.isArray(state.endpoints_found) ? state.endpoints_found.length : 0;
  log.info(`Progress saved: ${bc} batches, ${ef} endpoints`);
}

/**
 * Create a fresh progress state object for a given target.
 *
 * Does **not** write to disk — call {@link saveProgress} when ready.
 *
 * @param {string} target - The target identifier (e.g. a URL or domain).
 * @returns {object} A new progress state object.
 */
function initProgress(target) {
  return {
    status: 'in_progress',
    target: target,
    batches_completed: 0,
    current_batch: [],
    urls_queued: [],
    urls_scraped: [],
    urls_failed: [],
    endpoints_found: [],
    last_updated: '',
  };
}

/**
 * Check whether an error indicates Firecrawl credit exhaustion.
 *
 * Looks for HTTP 402 (Payment Required), HTTP 429 (Rate Limit with quota
 * messaging), or a message containing credit-related exhaustion keywords.
 *
 * @param {Error & { statusCode?: number, status?: number }} err - The error to inspect.
 * @returns {boolean} `true` if the error signals credit exhaustion.
 */
function isCreditExhaustedError(err) {
  if (!err) return false;

  // HTTP status code checks (common on axios/fetch errors)
  if (err.statusCode === 402) return true;
  if (err.statusCode === 429) return true;
  if (err.status === 402) return true;
  if (err.status === 429) return true;

  // Message-based check (case-insensitive)
  if (typeof err.message === 'string') {
    const msg = err.message.toLowerCase();
    const hasCredit = msg.includes('credit');
    const hasKeyword = msg.includes('exhausted') || msg.includes('insufficient') || msg.includes('quota');
    if (hasCredit && hasKeyword) return true;
  }

  return false;
}

/**
 * Prepend an array of URLs to the front of the queue.
 *
 * Mutates `state.urls_queued` in place. URLs already present in the queue
 * are skipped (deduplicated). Designed for credit-exhaustion rollback so
 * that unprocessed batch URLs go back to the front.
 *
 * @param {object} state - The progress state to mutate.
 * @param {string[]} urls - URLs to prepend.
 * @returns {void}
 */
function prependToQueue(state, urls) {
  const existing = new Set(state.urls_queued || []);
  const toPrepend = urls.filter((url) => !existing.has(url));
  state.urls_queued.unshift(...toPrepend);
}

module.exports = {
  PROGRESS_FILE,
  loadProgress,
  saveProgress,
  initProgress,
  isCreditExhaustedError,
  prependToQueue,
};
