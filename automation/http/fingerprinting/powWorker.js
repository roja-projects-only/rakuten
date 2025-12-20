/**
 * =============================================================================
 * POW WORKER - Worker thread for CPU-intensive Proof-of-Work computation
 * =============================================================================
 * 
 * This worker is spawned by the worker pool to offload MurmurHash3 POW
 * calculations from the main event loop.
 * 
 * OPTIMIZATIONS:
 * - Pre-allocated buffer reuse (no allocations in hot loop)
 * - Fast random using crypto.randomFillSync with buffer pool
 * - Direct byte manipulation instead of string operations
 * - Native murmurhash with hex output
 * 
 * Message format:
 * - Input: { id, key, seed, mask, maxIterations }
 * - Output: { id, success, result?, error?, iterations?, executionTime? }
 * =============================================================================
 */

const { parentPort } = require('worker_threads');
const crypto = require('crypto');

// Try native murmurhash first (faster), fallback to pure JS
let murmurHash128;
let useNative = false;
try {
  const native = require('murmurhash-native');
  // Native API: murmurHash(data{Buffer}, output_type[, seed])
  // For Buffer input, order is: (buffer, 'hex', seed)
  murmurHash128 = (buffer, seed) => native.murmurHash128x64(buffer, 'hex', seed);
  useNative = true;
} catch {
  const MurmurHash3 = require('murmurhash3js-revisited');
  // JS version needs array of bytes, not Buffer
  murmurHash128 = (buffer, seed) => MurmurHash3.x64.hash128(Array.from(buffer), seed);
}

// Character set for suffix generation (alphanumeric)
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CHARSET_LEN = CHARSET.length;

// Pre-allocated buffers for performance
const HASH_BUFFER_SIZE = 16; // Fixed size for stringToHash
const hashBuffer = Buffer.alloc(HASH_BUFFER_SIZE);

// Random pool for faster random generation (refill every N iterations)
const RANDOM_POOL_SIZE = 4096;
const randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
let randomPoolIndex = RANDOM_POOL_SIZE; // Start exhausted to trigger first fill

/**
 * Get next random byte from pool (refills when exhausted)
 */
function getRandomByte() {
  if (randomPoolIndex >= RANDOM_POOL_SIZE) {
    crypto.randomFillSync(randomPool);
    randomPoolIndex = 0;
  }
  return randomPool[randomPoolIndex++];
}

/**
 * Fill suffix portion of hash buffer with random chars
 * @param {number} keyLen - Length of key prefix
 */
function fillRandomSuffix(keyLen) {
  for (let i = keyLen; i < HASH_BUFFER_SIZE; i++) {
    hashBuffer[i] = CHARSET.charCodeAt(getRandomByte() % CHARSET_LEN);
  }
}

/**
 * Convert result buffer to string
 */
function bufferToString() {
  return hashBuffer.toString('utf8', 0, HASH_BUFFER_SIZE);
}

/**
 * Check if hash starts with mask (case-insensitive)
 */
function checkMask(hash, mask) {
  if (!mask) return true;
  // Compare lowercase - hash is already lowercase from native
  const maskLower = mask.toLowerCase();
  for (let i = 0; i < maskLower.length; i++) {
    if (hash.charCodeAt(i) !== maskLower.charCodeAt(i) && 
        hash.toLowerCase().charCodeAt(i) !== maskLower.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

/**
 * Solve POW challenge (optimized)
 */
function solvePow({ key, seed, mask, maxIterations = 8000000 }) {
  const startTime = Date.now();
  const keyLen = key.length;
  
  // Write key to the start of buffer (only once)
  hashBuffer.write(key, 0, keyLen, 'utf8');
  
  // Pre-compute mask check length for faster comparison
  const maskLower = mask ? mask.toLowerCase() : '';
  const maskLen = maskLower.length;
  
  // Ensure seed is a valid number
  const hashSeed = typeof seed === 'number' ? seed : parseInt(seed, 10) || 0;
  
  let iterations = 0;
  let found = false;
  let hash;
  
  do {
    iterations++;
    
    // Fill random suffix directly in buffer
    fillRandomSuffix(keyLen);
    
    // Compute hash with seed
    hash = murmurHash128(hashBuffer, hashSeed);
    
    // Fast mask check (inline for performance)
    if (maskLen === 0) {
      found = true;
    } else {
      found = true;
      for (let i = 0; i < maskLen; i++) {
        if (hash.charCodeAt(i) !== maskLower.charCodeAt(i)) {
          found = false;
          break;
        }
      }
    }
    
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
    result: bufferToString(),
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

