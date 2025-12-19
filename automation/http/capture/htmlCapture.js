/**
 * =============================================================================
 * HTML CAPTURE - Account data extraction via HTML scraping
 * =============================================================================
 * 
 * Fallback HTML scraping method when API capture fails.
 * Extracts points from Rakuten home page.
 * 
 * =============================================================================
 */

const cheerio = require('cheerio');
const { createLogger } = require('../../../logger');

const log = createLogger('html-capture');

const TARGET_HOME_URL = 'https://www.rakuten.co.jp/';

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
  captureViaHtml,
  extractPoints,
};

