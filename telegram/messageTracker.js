/**
 * =============================================================================
 * MESSAGE TRACKER - Track forwarded channel messages for updates/deletion
 * =============================================================================
 * 
 * Generates unique tracking codes for forwarded messages and stores message
 * references in Redis. Enables:
 * - Deleting messages when credentials become INVALID
 * - Updating messages when credentials become BLOCKED
 * 
 * Redis Schema:
 *   msg:{trackingCode} -> { messageId, chatId, username, password, forwardedAt }
 *   msg:cred:{username}:{password} -> trackingCode (reverse lookup)
 * 
 * =============================================================================
 */

const crypto = require('crypto');
const { createLogger } = require('../logger');

const log = createLogger('msg-tracker');

const REDIS_PREFIX = 'msg:';
const CRED_PREFIX = 'msg:cred:';
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let redisClient = null;
let initialized = false;

/**
 * Initialize the message tracker with Redis client.
 * @returns {Promise<boolean>} True if initialized successfully
 */
async function initMessageTracker() {
  if (initialized) return true;
  
  if (!process.env.REDIS_URL) {
    log.warn('Message tracker requires Redis (REDIS_URL not set)');
    return false;
  }
  
  try {
    const { getRedisClient, isRedisBackend } = require('../automation/batch/processedStore');
    if (isRedisBackend()) {
      redisClient = getRedisClient();
      if (redisClient) {
        initialized = true;
        log.debug('Message tracker initialized (reusing Redis client)');
        return true;
      }
    }
  } catch (err) {
    log.warn(`Message tracker init failed: ${err.message}`);
  }
  
  return false;
}

/**
 * Generate a unique tracking code from credentials.
 * Format: RK-XXXXXXXX (8 hex chars based on credential hash + timestamp)
 */
function generateTrackingCode(username, password) {
  const data = `${username}:${password}:${Date.now()}:${Math.random()}`;
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  return `RK-${hash.substring(0, 8).toUpperCase()}`;
}

function makeCredKey(username, password) {
  return `${username}:${password}`;
}

/**
 * Store a message reference in Redis.
 */
async function storeMessageRef(trackingCode, messageRef, ttlMs = DEFAULT_TTL_MS) {
  if (!await initMessageTracker()) return false;
  
  const { messageId, chatId, username, password } = messageRef;
  const ttlSeconds = Math.ceil(ttlMs / 1000);
  
  try {
    const data = JSON.stringify({
      messageId,
      chatId: String(chatId),
      username,
      password,
      forwardedAt: Date.now(),
    });
    
    const pipeline = redisClient.pipeline();
    pipeline.setex(`${REDIS_PREFIX}${trackingCode}`, ttlSeconds, data);
    
    const credKey = makeCredKey(username, password);
    pipeline.setex(`${CRED_PREFIX}${credKey}`, ttlSeconds, trackingCode);
    
    await pipeline.exec();
    
    log.debug(`Stored message ref: ${trackingCode} -> msgId=${messageId}`);
    return true;
  } catch (err) {
    log.warn(`Failed to store message ref: ${err.message}`);
    return false;
  }
}

/**
 * Get message reference by tracking code.
 */
async function getMessageRefByCode(trackingCode) {
  if (!await initMessageTracker()) return null;
  
  try {
    const data = await redisClient.get(`${REDIS_PREFIX}${trackingCode}`);
    if (!data) return null;
    return JSON.parse(data);
  } catch (err) {
    log.warn(`Failed to get message ref: ${err.message}`);
    return null;
  }
}

/**
 * Get message reference by credentials (reverse lookup).
 */
async function getMessageRefByCredentials(username, password) {
  if (!await initMessageTracker()) return null;
  
  try {
    const credKey = makeCredKey(username, password);
    const trackingCode = await redisClient.get(`${CRED_PREFIX}${credKey}`);
    
    if (!trackingCode) return null;
    
    const messageRef = await getMessageRefByCode(trackingCode);
    if (!messageRef) return null;
    
    return { ...messageRef, trackingCode };
  } catch (err) {
    log.warn(`Failed to get message ref by credentials: ${err.message}`);
    return null;
  }
}

/**
 * Delete message reference from Redis.
 */
async function deleteMessageRef(username, password) {
  if (!await initMessageTracker()) return false;
  
  try {
    const credKey = makeCredKey(username, password);
    const trackingCode = await redisClient.get(`${CRED_PREFIX}${credKey}`);
    
    if (!trackingCode) return false;
    
    const pipeline = redisClient.pipeline();
    pipeline.del(`${REDIS_PREFIX}${trackingCode}`);
    pipeline.del(`${CRED_PREFIX}${credKey}`);
    await pipeline.exec();
    
    log.debug(`Deleted message ref: ${trackingCode}`);
    return true;
  } catch (err) {
    log.warn(`Failed to delete message ref: ${err.message}`);
    return false;
  }
}

/**
 * Clear forward store entry for credential (allow re-forwarding after delete).
 */
async function clearForwardedStatus(username, password) {
  if (!await initMessageTracker()) return false;
  
  try {
    const credKey = makeCredKey(username, password);
    await redisClient.del(`fwd:${credKey}`);
    log.debug(`Cleared forwarded status: ${username.slice(0, 5)}***`);
    return true;
  } catch (err) {
    log.warn(`Failed to clear forwarded status: ${err.message}`);
    return false;
  }
}

module.exports = {
  initMessageTracker,
  generateTrackingCode,
  storeMessageRef,
  getMessageRefByCode,
  getMessageRefByCredentials,
  deleteMessageRef,
  clearForwardedStatus,
  DEFAULT_TTL_MS,
};
