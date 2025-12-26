/**
 * =============================================================================
 * SESSION MANAGER - HTTP SESSION LIFECYCLE MANAGEMENT
 * =============================================================================
 * 
 * Manages HTTP sessions with:
 * - Cookie jar persistence
 * - Session recycling (similar to browser recycling)
 * - Request tracking
 * - Automatic cleanup
 * 
 * =============================================================================
 */

const { CookieJar } = require('tough-cookie');
const { createHttpClient } = require('./httpClient');
const { createLogger } = require('../../logger');

const log = createLogger('session-mgr');

const DEFAULT_LIMITS = {
  maxAgeMs: 15 * 60 * 1000,   // 15 minutes
  maxIdleMs: 10 * 60 * 1000,  // 10 minutes  
  maxRequests: 100,            // Max requests per session
};

const activeSessions = new Map();

/**
 * Creates a new HTTP session with client and jar.
 * @param {Object} options - Session options
 * @param {string} [options.proxy] - Proxy URL
 * @param {number} [options.timeout] - Request timeout
 * @param {boolean} [options.batchMode=false] - Enable batch mode (reduced delays)
 * @returns {Object} Session object with client, jar, and metadata
 */
function createSession(options = {}) {
  const sessionId = generateSessionId();
  const sharedJar = new CookieJar();

  // Always create a direct client; create a proxied client only when proxy is provided
  const direct = createHttpClient({ ...options, proxy: null, jar: sharedJar });
  const proxied = options.proxy
    ? createHttpClient({ ...options, jar: sharedJar })
    : null;

  // Default session client is the direct client for speed; login flow can opt into proxiedClient
  const client = direct.client;
  
  const session = {
    id: sessionId,
    client,
    proxiedClient: proxied ? proxied.client : null,
    directClient: direct.client,
    jar: sharedJar,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    requestCount: 0,
    batchMode: options.batchMode || false,
    options,
  };

  activeSessions.set(sessionId, session);
  log.debug(`Session: ${sessionId}${session.batchMode ? ' [batch]' : ''}`);
  
  return session;
}

/**
 * Updates session usage timestamp and request count.
 * @param {Object} session - Session object
 */
function touchSession(session) {
  session.lastUsedAt = Date.now();
  session.requestCount += 1;
}

/**
 * Checks if session should be recycled based on limits.
 * @param {Object} session - Session object
 * @param {Object} [limits] - Custom limits
 * @returns {boolean} True if session should be recycled
 */
function shouldRecycleSession(session, limits = DEFAULT_LIMITS) {
  const now = Date.now();
  
  // Age limit
  if (limits.maxAgeMs && now - session.createdAt > limits.maxAgeMs) {
    log.debug(`Session ${session.id} exceeded age limit`);
    return true;
  }
  
  // Idle limit
  if (limits.maxIdleMs && now - session.lastUsedAt > limits.maxIdleMs) {
    log.debug(`Session ${session.id} exceeded idle limit`);
    return true;
  }
  
  // Request count limit
  if (limits.maxRequests && session.requestCount >= limits.maxRequests) {
    log.debug(`Session ${session.id} exceeded request limit`);
    return true;
  }
  
  return false;
}

/**
 * Closes a session and removes it from active sessions.
 * @param {Object} session - Session object
 */
function closeSession(session) {
  if (!session) return;
  
  activeSessions.delete(session.id);
  log.debug(`Session closed: ${session.id}`);
}

/**
 * Closes all active sessions.
 */
function closeAllSessions() {
  const count = activeSessions.size;
  activeSessions.clear();
  log.info(`Closed ${count} active sessions`);
}

/**
 * Generates a unique session ID.
 * @returns {string} Session ID
 */
function generateSessionId() {
  return `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Gets session statistics.
 * @returns {Object} Session stats
 */
function getSessionStats() {
  const sessions = Array.from(activeSessions.values());
  return {
    active: sessions.length,
    totalRequests: sessions.reduce((sum, s) => sum + s.requestCount, 0),
    avgAge: sessions.length > 0 
      ? sessions.reduce((sum, s) => sum + (Date.now() - s.createdAt), 0) / sessions.length
      : 0,
  };
}

module.exports = {
  createSession,
  touchSession,
  shouldRecycleSession,
  closeSession,
  closeAllSessions,
  getSessionStats,
  DEFAULT_LIMITS,
};
