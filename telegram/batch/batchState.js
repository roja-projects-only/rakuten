/**
 * =============================================================================
 * BATCH STATE - Centralized state management for batch processing
 * =============================================================================
 * 
 * Manages active batches, pending batches/files, and provides state helpers.
 * 
 * =============================================================================
 */

const { createLogger } = require('../../logger');
const log = createLogger('batch-state');

// Track active batches by chatId for /stop command
const activeBatches = new Map(); // chatId -> { batch, key }

// Pending batches and files waiting for user confirmation
const pendingBatches = new Map(); // key -> batch data
const pendingFiles = new Map(); // key -> file info

/**
 * Registers an active batch for a chat.
 * @param {number} chatId - Telegram chat ID
 * @param {Object} batch - Batch object
 * @param {string} key - Batch key
 */
function setActiveBatch(chatId, batch, key) {
  activeBatches.set(chatId, { batch, key });
  log.debug(`Set active batch for chat ${chatId}: ${batch.filename}`);
}

/**
 * Removes active batch for a chat.
 * @param {number} chatId - Telegram chat ID
 */
function clearActiveBatch(chatId) {
  activeBatches.delete(chatId);
}

/**
 * Gets active batch for a chat.
 * @param {number} chatId - Telegram chat ID
 * @returns {{ batch: Object, key: string }|undefined}
 */
function getActiveBatch(chatId) {
  return activeBatches.get(chatId);
}

/**
 * Aborts the active batch for a given chat.
 * @param {number} chatId - Telegram chat ID
 * @returns {{ aborted: boolean, batch?: Object }} Result with batch info for waiting
 */
function abortActiveBatch(chatId) {
  const active = activeBatches.get(chatId);
  if (active && active.batch) {
    active.batch.aborted = true;
    log.info(`Abort via /stop command chatId=${chatId} file=${active.batch.filename}`);
    return { aborted: true, batch: active.batch };
  }
  return { aborted: false };
}

/**
 * Checks if there's an active batch for a given chat.
 * @param {number} chatId - Telegram chat ID
 * @returns {boolean}
 */
function hasActiveBatch(chatId) {
  return activeBatches.has(chatId);
}

/**
 * Gets all active batches with their progress.
 * @returns {Array<{chatId: number, filename: string, processed: number, total: number}>}
 */
function getAllActiveBatches() {
  const batches = [];
  for (const [chatId, { batch }] of activeBatches.entries()) {
    if (batch && !batch.aborted) {
      batches.push({
        chatId,
        filename: batch.filename,
        processed: batch.processed || 0,
        total: batch.count,
      });
    }
  }
  return batches;
}

/**
 * Wait for all active batches to complete.
 * @returns {Promise<void>}
 */
async function waitForAllBatchCompletion() {
  const promises = [];
  for (const [, { batch }] of activeBatches.entries()) {
    if (batch && batch._completionPromise && !batch.aborted) {
      promises.push(batch._completionPromise);
    }
  }
  
  if (promises.length === 0) return;
  await Promise.all(promises);
}

// Pending batch helpers
function getPendingBatch(key) {
  return pendingBatches.get(key);
}

function setPendingBatch(key, batch) {
  pendingBatches.set(key, batch);
}

function deletePendingBatch(key) {
  pendingBatches.delete(key);
}

// Pending file helpers
function getPendingFile(key) {
  return pendingFiles.get(key);
}

function setPendingFile(key, file) {
  pendingFiles.set(key, file);
}

function deletePendingFile(key) {
  pendingFiles.delete(key);
}

module.exports = {
  // Active batch management
  setActiveBatch,
  clearActiveBatch,
  getActiveBatch,
  abortActiveBatch,
  hasActiveBatch,
  getAllActiveBatches,
  waitForAllBatchCompletion,
  
  // Pending batch management
  getPendingBatch,
  setPendingBatch,
  deletePendingBatch,
  
  // Pending file management
  getPendingFile,
  setPendingFile,
  deletePendingFile,
};

