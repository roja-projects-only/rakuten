/**
 * =============================================================================
 * HTTP DATA CAPTURE - HTML-BASED ACCOUNT DATA EXTRACTION
 * =============================================================================
 * 
 * Extracts account data (points, membership rank, etc.) from HTML responses.
 * HTTP-based equivalent of dataCapture.js which used Puppeteer page objects.
 * 
 * =============================================================================
 */

const cheerio = require('cheerio');
const { createLogger } = require('../../logger');

const log = createLogger('http-capture');

// Target URLs for data extraction
const TARGET_HOME_URL = 'https://www.rakuten.co.jp/';
const TARGET_POINTS_URL = 'https://point.rakuten.co.jp/';

// Membership rank translations
const MEMBERSHIP_TRANSLATIONS = {
  'プラチナ会員': 'Platinum',
  'ゴールド会員': 'Gold',
  'シルバー会員': 'Silver',
  'ブロンズ会員': 'Bronze',
  'ダイヤモンド会員': 'Diamond',
  '通常会員': 'Regular',
};

/**
 * Captures account data from authenticated session.
 * HTTP equivalent of dataCapture.captureAccountData()
 * 
 * @param {Object} session - Authenticated HTTP session
 * @param {Object} [options] - Capture options
 * @param {number} [options.timeoutMs=30000] - Request timeout
 * @returns {Promise<Object>} Account data (points, rank, cash)
 */
async function captureAccountData(session, options = {}) {
  const { timeoutMs = 30000 } = options;
  const { client } = session;
  
  log.info('Capturing account data from home page...');
  
  try {
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
    let pointsText = 'n/a';
    let membershipText = 'n/a';
    
    // Try multiple extraction strategies
    pointsText = extractPoints($, homeResponse.data) || 'n/a';
    membershipText = extractMembership($, homeResponse.data) || 'n/a';
    
    // If membership not found on home page, try points page
    if (membershipText === 'n/a') {
      try {
        log.info('Membership not found on home page, checking points page...');
        const pointsResponse = await client.get(TARGET_POINTS_URL, {
          timeout: timeoutMs,
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Referer': TARGET_HOME_URL,
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'cross-site',
          },
        });
        
        const $points = cheerio.load(pointsResponse.data);
        membershipText = extractMembership($points, pointsResponse.data) || 'n/a';
      } catch (err) {
        log.warn('Failed to fetch points page:', err.message);
      }
    }
    
    // Translate membership status
    const membershipEnglish = MEMBERSHIP_TRANSLATIONS[membershipText] || membershipText;
    
    log.info(`Captured - points: ${pointsText}, membership: ${membershipEnglish}`);
    
    return {
      points: pointsText,
      cash: 'n/a',
      rank: membershipEnglish,
      url: TARGET_HOME_URL,
    };
  } catch (error) {
    log.error('Data capture failed:', error.message);
    throw new Error(`Failed to capture account data: ${error.message}`);
  }
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

/**
 * Extracts membership rank from page content.
 * @param {CheerioAPI} $ - Cheerio instance
 * @param {string} html - Raw HTML
 * @returns {string|null} Membership rank
 */
function extractMembership($, html) {
  // Strategy 1: Look for <em> tags containing membership text
  const emElements = $('em');
  for (let i = 0; i < emElements.length; i++) {
    const text = $(emElements[i]).text().trim();
    if (text.match(/^(ダイヤモンド|プラチナ|ゴールド|シルバー|ブロンズ|通常)会員$/)) {
      return text;
    }
  }
  
  // Strategy 2: Search in raw HTML
  const membershipPattern = /(ダイヤモンド|プラチナ|ゴールド|シルバー|ブロンズ|通常)会員/;
  const htmlMatch = html.match(membershipPattern);
  if (htmlMatch) {
    return htmlMatch[0];
  }
  
  // Strategy 3: Look in specific common locations
  const headerInfo = $('.header-info, .user-info, .member-info');
  if (headerInfo.length > 0) {
    const text = headerInfo.text();
    const match = text.match(membershipPattern);
    if (match) {
      return match[0];
    }
  }
  
  return null;
}

module.exports = {
  captureAccountData,
  extractPoints,
  extractMembership,
  MEMBERSHIP_TRANSLATIONS,
};
