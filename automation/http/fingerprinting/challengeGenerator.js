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
  mask = mask || '';
  const prefix = hash.substring(0, mask.length);
  return prefix.localeCompare(mask) === 0;
}

// ============================================================================
// MurmurHash3 128-bit implementation (x64 variant)
// Ported from r10-challenger JavaScript
// ============================================================================

/**
 * 64-bit addition using two 32-bit integers [high, low]
 */
function add64(a, b) {
  const a0 = a[0] >>> 16, a1 = a[0] & 65535, a2 = a[1] >>> 16, a3 = a[1] & 65535;
  const b0 = b[0] >>> 16, b1 = b[0] & 65535, b2 = b[1] >>> 16, b3 = b[1] & 65535;
  const c = [0, 0, 0, 0];
  
  c[3] += a3 + b3;
  c[2] += c[3] >>> 16;
  c[3] &= 65535;
  c[2] += a2 + b2;
  c[1] += c[2] >>> 16;
  c[2] &= 65535;
  c[1] += a1 + b1;
  c[0] += c[1] >>> 16;
  c[1] &= 65535;
  c[0] += a0 + b0;
  c[0] &= 65535;
  
  return [c[0] << 16 | c[1], c[2] << 16 | c[3]];
}

/**
 * 64-bit multiplication using two 32-bit integers [high, low]
 */
function mul64(a, b) {
  const a0 = a[0] >>> 16, a1 = a[0] & 65535, a2 = a[1] >>> 16, a3 = a[1] & 65535;
  const b0 = b[0] >>> 16, b1 = b[0] & 65535, b2 = b[1] >>> 16, b3 = b[1] & 65535;
  const c = [0, 0, 0, 0];
  
  c[3] += a3 * b3;
  c[2] += c[3] >>> 16;
  c[3] &= 65535;
  c[2] += a2 * b3;
  c[1] += c[2] >>> 16;
  c[2] &= 65535;
  c[2] += a3 * b2;
  c[1] += c[2] >>> 16;
  c[2] &= 65535;
  c[1] += a1 * b3;
  c[0] += c[1] >>> 16;
  c[1] &= 65535;
  c[1] += a2 * b2;
  c[0] += c[1] >>> 16;
  c[1] &= 65535;
  c[1] += a3 * b1;
  c[0] += c[1] >>> 16;
  c[1] &= 65535;
  c[0] += a0 * b3 + a1 * b2 + a2 * b1 + a3 * b0;
  c[0] &= 65535;
  
  return [c[0] << 16 | c[1], c[2] << 16 | c[3]];
}

/**
 * 64-bit rotate left
 */
function rotl64(a, n) {
  n = n % 64;
  if (n === 32) return [a[1], a[0]];
  if (n < 32) {
    return [
      a[0] << n | a[1] >>> (32 - n),
      a[1] << n | a[0] >>> (32 - n)
    ];
  }
  n -= 32;
  return [
    a[1] << n | a[0] >>> (32 - n),
    a[0] << n | a[1] >>> (32 - n)
  ];
}

/**
 * 64-bit left shift
 */
function shl64(a, n) {
  n = n % 64;
  if (n === 0) return a;
  if (n < 32) {
    return [a[0] << n | a[1] >>> (32 - n), a[1] << n];
  }
  return [a[1] << (n - 32), 0];
}

/**
 * 64-bit XOR
 */
function xor64(a, b) {
  return [a[0] ^ b[0], a[1] ^ b[1]];
}

/**
 * Finalization mix function (fmix64)
 */
function fmix64(h) {
  h = xor64(h, [0, h[0] >>> 1]);
  h = mul64(h, [4283543511, 3981806797]); // 0xff51afd7ed558ccd
  h = xor64(h, [0, h[0] >>> 1]);
  h = mul64(h, [3301882366, 444984403]);  // 0xc4ceb9fe1a85ec53
  h = xor64(h, [0, h[0] >>> 1]);
  return h;
}

/**
 * MurmurHash3 128-bit (x64) implementation.
 * @param {string} str - String to hash
 * @param {number} seed - Seed value
 * @returns {string} 32-character hex hash
 */
function murmurHash3_x64_128(str, seed) {
  str = str || '';
  seed = seed || 0;
  
  const len = str.length;
  const remainder = len % 16;
  const blocks = len - remainder;
  
  let h1 = [0, seed];
  let h2 = [0, seed];
  let k1 = [0, 0];
  let k2 = [0, 0];
  
  const c1 = [2277735313, 289559509];   // 0x87c37b91114253d5
  const c2 = [1291169091, 658871167];   // 0x4cf5ad432745937f
  
  // Process 16-byte blocks
  for (let i = 0; i < blocks; i += 16) {
    k1 = [
      str.charCodeAt(i + 4) & 255 | (str.charCodeAt(i + 5) & 255) << 8 | (str.charCodeAt(i + 6) & 255) << 16 | (str.charCodeAt(i + 7) & 255) << 24,
      str.charCodeAt(i) & 255 | (str.charCodeAt(i + 1) & 255) << 8 | (str.charCodeAt(i + 2) & 255) << 16 | (str.charCodeAt(i + 3) & 255) << 24
    ];
    k2 = [
      str.charCodeAt(i + 12) & 255 | (str.charCodeAt(i + 13) & 255) << 8 | (str.charCodeAt(i + 14) & 255) << 16 | (str.charCodeAt(i + 15) & 255) << 24,
      str.charCodeAt(i + 8) & 255 | (str.charCodeAt(i + 9) & 255) << 8 | (str.charCodeAt(i + 10) & 255) << 16 | (str.charCodeAt(i + 11) & 255) << 24
    ];
    
    k1 = mul64(k1, c1);
    k1 = rotl64(k1, 31);
    k1 = mul64(k1, c2);
    h1 = xor64(h1, k1);
    h1 = rotl64(h1, 27);
    h1 = add64(h1, h2);
    h1 = add64(mul64(h1, [0, 5]), [0, 1390208809]);
    
    k2 = mul64(k2, c2);
    k2 = rotl64(k2, 33);
    k2 = mul64(k2, c1);
    h2 = xor64(h2, k2);
    h2 = rotl64(h2, 31);
    h2 = add64(h2, h1);
    h2 = add64(mul64(h2, [0, 5]), [0, 944331445]);
  }
  
  // Process remainder
  k1 = [0, 0];
  k2 = [0, 0];
  const k = blocks;
  
  switch (remainder) {
    case 15: k2 = xor64(k2, shl64([0, str.charCodeAt(k + 14)], 48)); // fall through
    case 14: k2 = xor64(k2, shl64([0, str.charCodeAt(k + 13)], 40)); // fall through
    case 13: k2 = xor64(k2, shl64([0, str.charCodeAt(k + 12)], 32)); // fall through
    case 12: k2 = xor64(k2, shl64([0, str.charCodeAt(k + 11)], 24)); // fall through
    case 11: k2 = xor64(k2, shl64([0, str.charCodeAt(k + 10)], 16)); // fall through
    case 10: k2 = xor64(k2, shl64([0, str.charCodeAt(k + 9)], 8)); // fall through
    case 9:
      k2 = xor64(k2, [0, str.charCodeAt(k + 8)]);
      k2 = mul64(k2, c2);
      k2 = rotl64(k2, 33);
      k2 = mul64(k2, c1);
      h2 = xor64(h2, k2);
      // fall through
    case 8: k1 = xor64(k1, shl64([0, str.charCodeAt(k + 7)], 56)); // fall through
    case 7: k1 = xor64(k1, shl64([0, str.charCodeAt(k + 6)], 48)); // fall through
    case 6: k1 = xor64(k1, shl64([0, str.charCodeAt(k + 5)], 40)); // fall through
    case 5: k1 = xor64(k1, shl64([0, str.charCodeAt(k + 4)], 32)); // fall through
    case 4: k1 = xor64(k1, shl64([0, str.charCodeAt(k + 3)], 24)); // fall through
    case 3: k1 = xor64(k1, shl64([0, str.charCodeAt(k + 2)], 16)); // fall through
    case 2: k1 = xor64(k1, shl64([0, str.charCodeAt(k + 1)], 8)); // fall through
    case 1:
      k1 = xor64(k1, [0, str.charCodeAt(k)]);
      k1 = mul64(k1, c1);
      k1 = rotl64(k1, 31);
      k1 = mul64(k1, c2);
      h1 = xor64(h1, k1);
      break;
  }
  
  // Finalization
  h1 = xor64(h1, [0, len]);
  h2 = xor64(h2, [0, len]);
  h1 = add64(h1, h2);
  h2 = add64(h2, h1);
  h1 = fmix64(h1);
  h2 = fmix64(h2);
  h1 = add64(h1, h2);
  h2 = add64(h2, h1);
  
  // Format as 32-char hex string
  return (
    ('00000000' + (h1[0] >>> 0).toString(16)).slice(-8) +
    ('00000000' + (h1[1] >>> 0).toString(16)).slice(-8) +
    ('00000000' + (h2[0] >>> 0).toString(16)).slice(-8) +
    ('00000000' + (h2[1] >>> 0).toString(16)).slice(-8)
  );
}

/**
 * Solves the Proof-of-Work challenge.
 * Finds a stringToHash = key + randomSuffix where murmurHash3(stringToHash, seed) starts with mask.
 * 
 * @param {Object} params - POW parameters
 * @param {string} params.key - Key from mdata (hex string)
 * @param {number} params.seed - Seed from mdata (integer)
 * @param {string} params.mask - Mask from mdata (hex prefix to match)
 * @param {number} [maxIterations=1000000] - Maximum iterations before giving up
 * @returns {Object} { stringToHash, iterations, executionTime }
 * @throws {Error} If max iterations reached without finding solution
 */
function solvePow(params, maxIterations = 1000000) {
  const { key, seed, mask } = params;
  let found = false;
  let stringToHash = '';
  let iterations = 0;
  const startTime = Date.now();
  
  do {
    iterations++;
    stringToHash = key + generateRandomSuffix(key.length, 16);
    const hash = murmurHash3_x64_128(stringToHash, seed);
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
  murmurHash3_x64_128,
  solvePow,
  computeCresFromMdata,
  generateRandomCres,
};
