/**
 * =============================================================================
 * HTTP DATA CAPTURE - Orchestrator module
 * =============================================================================
 * 
 * Main entry point for account data capture.
 * Coordinates API capture, HTML fallback, order history, and profile data.
 * 
 * =============================================================================
 */

const { createLogger } = require('../../../logger');
const { captureViaApi, RANK_MAP } = require('./apiCapture');
const { captureViaHtml, extractPoints } = require('./htmlCapture');
const { fetchLatestOrder } = require('./orderHistory');
const { fetchProfileData } = require('./profileData');

const log = createLogger('http-capture');

/**
 * Captures account data from authenticated session using API.
 * HTTP equivalent of dataCapture.captureAccountData()
 * 
 * @param {Object} session - Authenticated HTTP session
 * @param {Object} [options] - Capture options
 * @param {number} [options.timeoutMs=30000] - Request timeout
 * @returns {Promise<Object>} Account data (points, rank, cash)
 */
async function captureAccountData(session, options = {}) {
  const { timeoutMs = 30000 } = options;
  const { client, jar } = session;
  
  log.debug('Fetching account data');
  
  try {
    // Try API-based capture directly (we already have session cookies from login)
    let result = await captureViaApi(client, jar, timeoutMs);
    if (!result) {
      // Fallback to HTML scraping if API fails
      log.warn('API capture failed, falling back to HTML scraping...');
      result = await captureViaHtml(client, jar, timeoutMs);
    } else {
      log.info(`API capture - points: ${result.points}, rank: ${result.rank}, cash: ${result.cash}`);
    }
    
    // Fetch order history and profile data in PARALLEL for speed
    // Profile has its own 20s timeout since SSO gateway can be slow
    const PROFILE_TIMEOUT_MS = Math.min(timeoutMs, 20000);
    
    const [orderResult, profileResult] = await Promise.allSettled([
      fetchLatestOrder(client, jar, timeoutMs),
      Promise.race([
        fetchProfileData(client, jar, PROFILE_TIMEOUT_MS),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Profile timeout')), PROFILE_TIMEOUT_MS)
        ),
      ]),
    ]);
    
    // Process order result
    const orderInfo = orderResult.status === 'fulfilled' ? orderResult.value : null;
    if (orderInfo) {
      result.latestOrder = orderInfo.date || 'n/a';
      result.latestOrderId = orderInfo.orderId || 'n/a';
    } else {
      result.latestOrder = 'n/a';
      result.latestOrderId = 'n/a';
      if (orderResult.status === 'rejected') {
        log.warn(`Order fetch failed: ${orderResult.reason?.message}`);
      }
    }
    log.info(`Latest order: ${result.latestOrder} (ID: ${result.latestOrderId})`);
    
    // Process profile result
    const profileData = profileResult.status === 'fulfilled' ? profileResult.value : null;
    if (profileData) {
      result.profile = profileData;
      log.info(`Profile: ${profileData.name}, ${profileData.email}, DOB: ${profileData.dob}`);
    } else {
      result.profile = null;
      if (profileResult.status === 'rejected') {
        log.warn(`Profile fetch failed: ${profileResult.reason?.message}`);
      }
    }
    
    return result;
  } catch (error) {
    log.error('Data capture failed:', error.message);
    throw new Error(`Failed to capture account data: ${error.message}`);
  }
}

// Re-export for backwards compatibility
module.exports = {
  captureAccountData,
  captureViaApi,
  captureViaHtml,
  fetchLatestOrder,
  fetchProfileData,
  extractPoints,
  RANK_MAP,
};

