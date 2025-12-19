/**
 * =============================================================================
 * API CAPTURE - Account data extraction via ichiba-common API
 * =============================================================================
 * 
 * Direct API-based capture using ichiba-common-web-gateway.
 * Primary method for extracting points, rank, and Rakuten Cash.
 * 
 * =============================================================================
 */

const { createLogger } = require('../../../logger');
const { getCookieString } = require('../httpClient');

const log = createLogger('api-capture');

// API endpoint for account data
const HEADER_INFO_API = 'https://ichiba-common-web-gateway.rakuten.co.jp/ichiba-common/headerinfo/get/v1';
const HEADER_INFO_AUTHKEY = 'hin9ruj3haAPxBP0nBQBlaga6haUCobPR';
const TARGET_HOME_URL = 'https://www.rakuten.co.jp/';

// Membership rank number to string mapping (1=lowest, 5=highest)
const RANK_MAP = {
  1: 'Regular',
  2: 'Silver',
  3: 'Gold',
  4: 'Platinum',
  5: 'Diamond',
};

/**
 * Captures account data via ichiba-common API.
 * @param {Object} client - HTTP client
 * @param {Object} jar - Cookie jar
 * @param {number} timeoutMs - Request timeout
 * @returns {Promise<Object|null>} Account data or null on failure
 */
async function captureViaApi(client, jar, timeoutMs) {
  try {
    // Get cookies for the API request
    const cookieString = await getCookieString(jar, 'https://www.rakuten.co.jp/');
    
    // Request body - only request memberPointInfo
    const requestBody = {
      common: {
        params: { source: 'pc' },
        exclude: [null]
      },
      features: {
        memberPointInfo: {
          exclude: [null]
        }
      }
    };
    
    log.debug(`API request with cookies: ${cookieString.substring(0, 50)}...`);
    
    const response = await client.post(HEADER_INFO_API, requestBody, {
      timeout: timeoutMs,
      headers: {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'authkey': HEADER_INFO_AUTHKEY,
        'Origin': 'https://www.rakuten.co.jp',
        'Referer': 'https://www.rakuten.co.jp/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        'Cookie': cookieString,
      },
    });
    
    log.debug(`API response status: ${response.status}`);
    
    if (response.status !== 200 && response.status !== 207) {
      log.warn(`API returned status ${response.status}`);
      return null;
    }
    
    const data = response.data;
    log.debug('API response:', JSON.stringify(data).substring(0, 500));
    
    // Parse the response structure
    const memberPointInfo = data?.body?.memberPointInfo?.data;
    if (!memberPointInfo) {
      log.warn('No memberPointInfo in API response');
      return null;
    }
    
    const pointInfo = memberPointInfo.pointInfo || {};
    const pointInvestInfo = memberPointInfo.pointInvestInfo || {};
    
    // Extract values - use holdingPoint as primary, fallback to fixedStdPoint
    const points = pointInvestInfo.holdingPoint ?? pointInfo.fixedStdPoint ?? 'n/a';
    const cash = pointInfo.rcashPoint ?? 'n/a';
    const rankNum = pointInfo.rank;
    const rank = RANK_MAP[rankNum] || (rankNum ? `Rank ${rankNum}` : 'n/a');
    
    return {
      points: String(points),
      cash: String(cash),
      rank,
      url: TARGET_HOME_URL,
      rawData: {
        fixedStdPoint: pointInfo.fixedStdPoint,
        unfixedStdPoint: pointInfo.unfixedStdPoint,
        rcashPoint: pointInfo.rcashPoint,
        rank: rankNum,
        holdingPoint: pointInvestInfo.holdingPoint,
      },
    };
  } catch (error) {
    log.warn('API capture error:', error.message);
    return null;
  }
}

module.exports = {
  captureViaApi,
  RANK_MAP,
  HEADER_INFO_API,
  TARGET_HOME_URL,
};

