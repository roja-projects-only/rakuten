/**
 * =============================================================================
 * POW WORKER - Worker thread for CPU-intensive Proof-of-Work computation
 * =============================================================================
 * 
 * This worker is spawned by the worker pool to offload MurmurHash3 POW
 * calculations from the main event loop.
 * 
 * Message format:
 * - Input: { id, key, seed, mask, maxIterations }
 * - Output: { id, success, result?, error?, iterations?, executionTime? }
 * =============================================================================
 */

const { parentPort } = require('worker_threads');
const MurmurHash3 = require('murmurhash3js-revisited');

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate random suffix string
 */
function generateRandomSuffix(keyLen, totalLen) {
  let result = '';
  const targetLen = totalLen - keyLen;
  for (let i = 0; i < targetLen; i++) {
    result += CHARSET.charAt(Math.floor(Math.random() * CHARSET.length));
  }
  return result;
}

/**
 * Convert string to bytes for MurmurHash3
 */
function stringToBytes(str) {
  return Buffer.from(str, 'utf8');
}

/**
 * Check if hash starts with mask
 */
function checkMask(hash, mask) {
  if (!mask) return true;
  return hash.toLowerCase().startsWith(mask.toLowerCase());
}

/**
 * Solve POW challenge
 */
function solvePow({ key, seed, mask, maxIterations = 8000000 }) {
  let found = false;
  let stringToHash = '';
  let iterations = 0;
  const startTime = Date.now();
  
  do {
    iterations++;
    stringToHash = key + generateRandomSuffix(key.length, 16);
    const bytes = stringToBytes(stringToHash);
    const hash = MurmurHash3.x64.hash128(bytes, seed);
    found = checkMask(hash, mask);
    
    if (iterations >= maxIterations) {
      return {
        success: false,
        error: `POW max iterations (${maxIterations}) reached`,
        iterations,
        executionTime: Date.now() - startTime
      };
    }
  } while (!found);
  
  return {
    success: true,
    result: stringToHash,
    iterations,
    executionTime: Date.now() - startTime
  };
}

// Listen for messages from main thread
parentPort.on('message', (msg) => {
  const { id, key, seed, mask, maxIterations } = msg;
  
  try {
    const result = solvePow({ key, seed, mask, maxIterations });
    parentPort.postMessage({ id, ...result });
  } catch (err) {
    parentPort.postMessage({
      id,
      success: false,
      error: err.message
    });
  }
});
