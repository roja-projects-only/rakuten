/**
 * =============================================================================
 * RAT GENERATOR - RAKUTEN ANALYTICS TRACKING DATA GENERATOR
 * =============================================================================
 * 
 * Generates realistic RAT (Rakuten Analytics Tracking) telemetry data that
 * mimics browser fingerprinting signals to avoid detection.
 * 
 * Based on observed request patterns from Chrome DevTools analysis.
 * 
 * =============================================================================
 */

const { createLogger } = require('../../../logger');

const log = createLogger('rat-gen');

/**
 * Generates RAT telemetry payload.
 * This is a simplified version - real implementation would need actual
 * browser fingerprinting data from Chrome DevTools capture.
 * 
 * @param {Object} options - Generation options
 * @param {string} [options.browser='Chrome'] - Browser type
 * @param {string} [options.os='Windows'] - Operating system
 * @param {string} [options.correlationId] - Correlation ID for tracking
 * @returns {Object} RAT telemetry data
 */
function generateRatData(options = {}) {
  const {
    browser = 'Chrome',
    os = 'Windows',
    correlationId = generateCorrelationId(),
  } = options;

  // Simplified RAT structure - would need to match actual format from DevTools
  const rat = {
    acc: '1249', // Account/application ID (observed in real requests)
    aid: 1,
    cp: generateComponentData(browser, os, correlationId),
  };

  log.debug('Generated RAT data');
  return rat;
}

/**
 * Generates component data section of RAT payload.
 * @param {string} browser - Browser type
 * @param {string} os - Operating system
 * @param {string} correlationId - Correlation ID
 * @returns {Object} Component data
 */
function generateComponentData(browser, os, correlationId) {
  const timestamp = Date.now();
  
  return {
    psx: timestamp, // Page session timestamp
    his: '\u276E01\u276F', // History state (encoded)
    s_m: 'Init', // State machine
    s_f: 'init_', // State function
    f_p: `"${generateFingerprint()}"`, // Fingerprint
    f_f: [ // Feature flags
      ['reenterEmailEnabled', true],
      ['reenterPasswordEnabled', true],
      ['enableNewChallenger', true],
      ['enableRealTimeFraudCheck', true],
      ['enableTrustedDevice', false],
    ],
    cid: 'rakuten_ichiba_top_web', // Client ID
    cor: correlationId, // Correlation ID
    x: 1920, // Screen width
    y: 1080, // Screen height
    coo: true, // Cookies enabled
    l_s: true, // Local storage enabled
    url: 'https://login.account.rakuten.com/sso/authorize', // Current URL
    w_s: false, // Web sockets
    lng: 'en-US', // Language
    env: 'production', // Environment
    msg: `Main.elm started, cor:${correlationId}`, // Message
    evt: 'StartedEvent', // Event type
    foc: true, // Window has focus
    vis: true, // Page is visible
    src: 'https://login.account.rakuten.com/widget', // Source
    inf: '2.27.1-5987-9c46', // Infrastructure version
  };
}

/**
 * Generates a correlation ID for request tracking.
 * Format: UUID v4
 * @returns {string} Correlation ID
 */
function generateCorrelationId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Generates a browser fingerprint hash.
 * Produces a 32-character hex string like MD5 hash.
 * @returns {string} Fingerprint hash (32-char hex)
 */
function generateFingerprint() {
  const crypto = require('crypto');
  const randomData = crypto.randomBytes(16).toString('hex');
  return randomData; // 32-char hex string like "e7e08a8942ed6789bc069ad1815a3515"
}

/**
 * Updates RAT data for different flow states.
 * @param {Object} ratData - Existing RAT data
 * @param {string} state - New state (e.g., 'email_submit', 'password_submit')
 * @returns {Object} Updated RAT data
 */
function updateRatState(ratData, state) {
  const updated = JSON.parse(JSON.stringify(ratData));
  
  updated.cp.psx = Date.now();
  
  switch (state) {
    case 'email_submit':
      updated.cp.s_m = 'E23_v2_login';
      updated.cp.s_f = 'request';
      updated.cp.msg = 'request,Login';
      updated.cp.evt = 'RequestEvent';
      break;
    case 'password_submit':
      updated.cp.s_m = 'E03_v2_login_complete';
      updated.cp.s_f = 'request';
      updated.cp.msg = 'request,LoginComplete';
      updated.cp.evt = 'RequestEvent';
      break;
    default:
      log.warn(`Unknown state: ${state}`);
  }
  
  return updated;
}

module.exports = {
  generateRatData,
  generateCorrelationId,
  generateFingerprint,
  updateRatState,
};
