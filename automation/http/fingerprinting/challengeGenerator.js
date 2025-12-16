/**
 * =============================================================================
 * CHALLENGE GENERATOR - AUTHENTICATION CHALLENGE TOKEN GENERATOR
 * =============================================================================
 * 
 * Generates challenge tokens used in the authentication flow.
 * 
 * The cres (challenge response) is computed using a Proof-of-Work algorithm:
 * 1. Generate stringToHash = key + random_suffix (16 chars total)
 * 2. Compute MurmurHash3-128(stringToHash, seed)
 * 3. Check if hash starts with mask
 * 4. Repeat until condition met
 * 5. Return stringToHash as cres
 * 
 * Algorithm reverse-engineered from r10-challenger-0.2.1-a6173d7.js
 * =============================================================================
 */

const crypto = require('crypto');
const MurmurHash3 = require('murmurhash3js-revisited');
const { createLogger } = require('../../../logger');

const log = createLogger('challenge-gen');

// Charset for random string generation (same as original)
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generates a random string of specified length using the charset.
 * @param {number} keyLen - Length of the key
 * @param {number} totalLen - Total desired length (usually 16)
 * @returns {string} Random string of length (totalLen - keyLen)
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
 * Checks if hash starts with the given mask.
 * @param {string} hash - 32-char hex hash
 * @param {string} mask - Mask prefix to check
 * @returns {boolean} True if hash starts with mask
 */
function checkMask(hash, mask) {
  if (!mask) return true;
  // Use simple string comparison (both should be lowercase hex)
  return hash.toLowerCase().startsWith(mask.toLowerCase());
}

/**
 * Converts a string to a byte array (UTF-8).
 * @param {string} str - Input string
 * @returns {Uint8Array} Byte array
 */
function stringToBytes(str) {
  return Buffer.from(str, 'utf8');
}

/**
 * Solves the Proof-of-Work challenge.
 * Finds a stringToHash = key + randomSuffix where murmurHash3(stringToHash, seed) starts with mask.
 * 
 * @param {Object} params - POW parameters
 * @param {string} params.key - Key from mdata (hex string)
 * @param {number} params.seed - Seed from mdata (integer)
 * @param {string} params.mask - Mask from mdata (hex prefix to match)
 * @param {number} [maxIterations=8000000] - Maximum iterations before giving up
 * @returns {Object} { stringToHash, iterations, executionTime }
 * @throws {Error} If max iterations reached without finding solution
 */
function solvePow(params, maxIterations = 8000000) {
  const { key, seed, mask } = params;
  let found = false;
  let stringToHash = '';
  let iterations = 0;
  const startTime = Date.now();
  
  do {
    iterations++;
    stringToHash = key + generateRandomSuffix(key.length, 16);
    // Convert string to bytes for murmurhash3js-revisited (expects byte array)
    const bytes = stringToBytes(stringToHash);
    const hash = MurmurHash3.x64.hash128(bytes, seed);
    found = checkMask(hash, mask);
    
    if (iterations >= maxIterations) {
      const executionTime = Date.now() - startTime;
      const error = new Error(`POW max iterations (${maxIterations}) reached without solution`);
      error.code = 'POW_MAX_ITERATIONS';
      error.iterations = iterations;
      error.executionTime = executionTime;
      throw error;
    }
  } while (!found);
  
  const executionTime = Date.now() - startTime;
  
  log.debug(`[pow] Solved in ${iterations} iterations (${executionTime}ms): ${stringToHash}`);
  
  return {
    stringToHash,
    iterations,
    executionTime
  };
}

/**
 * Computes cres from mdata returned by /util/gc endpoint.
 * 
 * The mdata structure is:
 * {
 *   "status": 200,
 *   "body": {
 *     "mask": "abce",  // hex prefix that hash must start with
 *     "key": "e2",     // hex string to prefix the cres
 *     "seed": 3973842396  // integer seed for MurmurHash3
 *   }
 * }
 * 
 * @param {string|Object} mdata - The mdata string or parsed object from /util/gc
 * @returns {string} The computed cres (16 chars)
 */
function computeCresFromMdata(mdata) {
  try {
    const mdataObj = typeof mdata === 'string' ? JSON.parse(mdata) : mdata;
    const body = mdataObj?.body;
    
    if (!body || !body.mask || !body.key || body.seed === undefined) {
      log.warn('[cres] Invalid mdata structure, falling back to random');
      log.debug(`[cres] mdata received: ${JSON.stringify(mdata)}`);
      return generateRandomCres();
    }
    
    const { mask, key, seed } = body;
    
    log.debug(`[cres] Computing POW with mask="${mask}" key="${key}" seed=${seed}`);
    
    // Solve the proof-of-work
    const result = solvePow({ key, seed, mask });
    
    log.info(`[cres] POW solved: ${result.stringToHash} (${result.iterations} iterations, ${result.executionTime}ms)`);
    
    return result.stringToHash;
    
  } catch (err) {
    // Re-throw POW failures so caller can retry
    if (err.code === 'POW_MAX_ITERATIONS') {
      log.warn(`[cres] POW failed after ${err.iterations} iterations (${err.executionTime}ms)`);
      throw err;
    }
    log.warn(`[cres] Computation failed: ${err.message}, falling back to random`);
    return generateRandomCres();
  }
}

/**
 * Generates a random 16-character cres (fallback when mdata unavailable).
 * @returns {string} Random cres
 */
function generateRandomCres() {
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += CHARSET.charAt(Math.floor(Math.random() * CHARSET.length));
  }
  return result;
}

/**
 * Generates a challenge token for authentication requests.
 * 
 * @param {Object} options - Generation options
 * @param {string} [options.type='cres'] - Challenge type (e.g., 'cres', 'token')
 * @param {string} [options.username] - Username for challenge
 * @param {number} [options.timestamp] - Timestamp for challenge
 * @param {string|Object} [options.mdata] - Mdata from /util/gc for cres computation
 * @returns {string} Challenge token
 */
function generateChallengeToken(options = {}) {
  const { type = 'cres', mdata = null } = options;
  
  if (type === 'cres') {
    // If mdata is provided, compute cres from it using POW
    if (mdata) {
      return computeCresFromMdata(mdata);
    }
    
    // Fallback: Generate random 16-char alphanumeric string
    const result = generateRandomCres();
    log.debug(`Generated random cres token: ${result}`);
    return result;
  }
  
  // For other types, generate random base64
  const randomBytes = crypto.randomBytes(32).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  
  log.debug(`Generated challenge token (${type}): ${randomBytes.substring(0, 12)}...`);
  return randomBytes;
}

/**
 * Generates a complete challenge object for API requests.
 * Format based on observed /v2/login/complete request structure.
 * 
 * @param {Object} options - Challenge options
 * @param {string} [options.username] - Username
 * @param {string} [options.previousToken] - Token from previous step
 * @param {Object} [options.mdata] - Mdata from /util/gc
 * @returns {Object} Challenge object
 */
function generateChallengeObject(options = {}) {
  const { username = '', previousToken = null, mdata = null } = options;
  
  const cres = generateChallengeToken({ type: 'cres', username, mdata });
  const token = previousToken || generateChallengeToken({ type: 'token', username });
  
  return {
    cres,
    token: `@St.ott-v2.${token}`,
  };
}

/**
 * Generates a tracking ID for requests.
 * Format: UUID v4
 * @returns {string} Tracking ID
 */
function generateTrackingId() {
  return crypto.randomUUID();
}

/**
 * Generates a session token.
 * Format: "@St.ott-v2.<32-char-part>.<large-base64-payload>"
 * Based on real captured tokens from Chrome DevTools.
 * 
 * @param {string} [prefix='St.ott-v2'] - Token prefix
 * @returns {string} Session token
 */
function generateSessionToken(prefix = 'St.ott-v2') {
  // Generate two parts: 32-char part and large payload (like real tokens)
  const part1 = crypto.randomBytes(24).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
    .substring(0, 32);
    
  const part2 = crypto.randomBytes(512).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  
  return `@${prefix}.${part1}.${part2}`;
}

/**
 * Simple string hashing function.
 * @param {string} str - String to hash
 * @returns {string} Hash
 */
function hashString(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Generates GC (garbage collection?) endpoint parameters.
 * Observed in /util/gc requests.
 * 
 * @param {Object} options - GC options
 * @param {string} options.clientId - Client ID
 * @param {string} options.trackingId - Tracking ID
 * @returns {Object} GC parameters
 */
function generateGcParams(options = {}) {
  const { clientId = 'rakuten_ichiba_top_web', trackingId } = options;
  
  return {
    client_id: clientId,
    tracking_id: trackingId || generateTrackingId(),
  };
}

/**
 * Validates a challenge token format.
 * @param {string} token - Token to validate
 * @returns {boolean} True if valid format
 */
function validateChallengeToken(token) {
  if (!token || typeof token !== 'string') {
    return false;
  }
  
  // Basic validation - real implementation would check actual format
  return token.length >= 16 && token.length <= 2048;
}

// Export internal functions for testing
module.exports = {
  generateChallengeToken,
  generateChallengeObject,
  generateTrackingId,
  generateSessionToken,
  generateGcParams,
  validateChallengeToken,
  hashString,
  // Export POW functions for testing
  solvePow,
  computeCresFromMdata,
  generateRandomCres,
};
