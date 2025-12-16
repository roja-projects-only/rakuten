/**
 * =============================================================================
 * HTTP DATA CAPTURE - API-BASED ACCOUNT DATA EXTRACTION
 * =============================================================================
 * 
 * Extracts account data (points, membership rank, Rakuten Cash) from API.
 * Uses ichiba-common-web-gateway API for direct data retrieval.
 * 
 * =============================================================================
 */

const cheerio = require('cheerio');
const { createLogger } = require('../../logger');
const { getCookieString } = require('./httpClient');

const log = createLogger('http-capture');

// API endpoint for account data
const HEADER_INFO_API = 'https://ichiba-common-web-gateway.rakuten.co.jp/ichiba-common/headerinfo/get/v1';

// Target URL for data extraction
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
    const apiResult = await captureViaApi(client, jar, timeoutMs);
    if (apiResult) {
      log.info(`API capture - points: ${apiResult.points}, rank: ${apiResult.rank}, cash: ${apiResult.cash}`);
      return apiResult;
    }
    
    // Fallback to HTML scraping if API fails
    log.warn('API capture failed, falling back to HTML scraping...');
    return await captureViaHtml(client, jar, timeoutMs);
  } catch (error) {
    log.error('Data capture failed:', error.message);
    throw new Error(`Failed to capture account data: ${error.message}`);
  }
}

// Static authkey for ichiba API (appears to be constant)
const HEADER_INFO_AUTHKEY = 'hin9ruj3haAPxBP0nBQBlaga6haUCobPR';

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

/**
 * Captures account data via HTML scraping (fallback).
 * @param {Object} client - HTTP client
 * @param {Object} jar - Cookie jar  
 * @param {number} timeoutMs - Request timeout
 * @returns {Promise<Object>} Account data
 */
async function captureViaHtml(client, jar, timeoutMs) {
  // Navigate to Rakuten home page
  const homeResponse = await client.get(TARGET_HOME_URL, {
    timeout: timeoutMs,
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    },
  });
  
  // Parse HTML
  const $ = cheerio.load(homeResponse.data);
  
  // Extract points from home page
  const pointsText = extractPoints($, homeResponse.data) || 'n/a';
  
  log.info(`HTML capture - points: ${pointsText}`);
  
  return {
    points: pointsText,
    cash: 'n/a',
    rank: 'n/a',
    url: TARGET_HOME_URL,
  };
}

/**
 * Extracts points value from page content.
 * @param {CheerioAPI} $ - Cheerio instance
 * @param {string} html - Raw HTML
 * @returns {string|null} Points value
 */
function extractPoints($, html) {
  // Strategy 1: Look for links with "保有ポイント" (held points) text
  const pointLinks = $('a:contains("保有ポイント")');
  if (pointLinks.length > 0) {
    const text = pointLinks.first().text();
    const match = text.match(/(\d{1,3}(?:,\d{3})*)/);
    if (match) {
      return match[1];
    }
  }
  
  // Strategy 2: Look for any links to point.rakuten with numbers
  const rakutenPointLinks = $('a[href*="point.rakuten"]');
  for (let i = 0; i < rakutenPointLinks.length; i++) {
    const text = $(rakutenPointLinks[i]).text();
    const match = text.match(/(\d{1,3}(?:,\d{3})*)/);
    if (match) {
      const value = parseInt(match[1].replace(/,/g, ''), 10);
      if (value > 100) { // Filter out small numbers (likely not points)
        return match[1];
      }
    }
  }
  
  // Strategy 3: Find largest comma-separated number in page (likely points)
  const allLinks = $('a');
  let largestPoints = null;
  let largestValue = 0;
  
  allLinks.each((i, elem) => {
    const text = $(elem).text();
    const matches = text.match(/(\d{1,3}(?:,\d{3})+)/g);
    if (matches) {
      for (const match of matches) {
        const numericValue = parseInt(match.replace(/,/g, ''), 10);
        if (numericValue > largestValue && numericValue < 999999) {
          largestValue = numericValue;
          largestPoints = match;
        }
      }
    }
  });
  
  if (largestPoints && largestValue > 100) {
    return largestPoints;
  }
  
  // Strategy 4: Regex search in raw HTML
  const pointsPattern = /保有ポイント[^\d]*(\d{1,3}(?:,\d{3})*)/;
  const htmlMatch = html.match(pointsPattern);
  if (htmlMatch) {
    return htmlMatch[1];
  }
  
  return null;
}

module.exports = {
  captureAccountData,
  captureViaApi,
  captureViaHtml,
  extractPoints,
  RANK_MAP,
};
