/**
 * =============================================================================
 * FILTER UTILS - Credential filtering against processed store
 * =============================================================================
 */

const { createLogger } = require('../../logger');
const {
  DEFAULT_TTL_MS,
  initProcessedStore,
  getProcessedStatusBatch,
  isSkippableStatus,
  makeKey,
} = require('../../automation/batch/processedStore');

const log = createLogger('batch-filter');

const PROCESSED_TTL_MS = parseInt(process.env.PROCESSED_TTL_MS, 10) || DEFAULT_TTL_MS;

/**
 * Filters credentials that have already been processed.
 * Uses batch MGET for efficient Redis lookups.
 * @param {Array} creds - Array of credential objects with username/password
 * @returns {Promise<{ filtered: Array, skipped: number }>}
 */
async function filterAlreadyProcessed(creds) {
  await initProcessedStore(PROCESSED_TTL_MS);
  
  log.info(`Filtering ${creds.length} credentials against processed store...`);
  
  // Build all keys first
  const credsWithKeys = creds.map(cred => ({
    ...cred,
    _dedupeKey: makeKey(cred.username, cred.password),
  }));
  
  // Batch lookup - single MGET call per 1000 keys instead of individual calls
  const allKeys = credsWithKeys.map(c => c._dedupeKey);
  const statusMap = await getProcessedStatusBatch(allKeys, PROCESSED_TTL_MS);
  
  const filtered = [];
  let skipped = 0;

  for (const cred of credsWithKeys) {
    const status = statusMap.get(cred._dedupeKey);
    if (status && isSkippableStatus(status)) {
      skipped += 1;
      continue;
    }
    filtered.push(cred);
  }

  log.info(`Done: ${filtered.length} to process, ${skipped} skipped (already processed)`);
  return { filtered, skipped };
}

module.exports = {
  filterAlreadyProcessed,
  PROCESSED_TTL_MS,
};

