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

// Order history URL
const ORDER_HISTORY_URL = 'https://order.my.rakuten.co.jp/purchase-history/order-list?l-id=pc_header_func_ph';

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
    let result = await captureViaApi(client, jar, timeoutMs);
    if (!result) {
      // Fallback to HTML scraping if API fails
      log.warn('API capture failed, falling back to HTML scraping...');
      result = await captureViaHtml(client, jar, timeoutMs);
    } else {
      log.info(`API capture - points: ${result.points}, rank: ${result.rank}, cash: ${result.cash}`);
    }
    
    // Fetch latest order info
    const orderInfo = await fetchLatestOrder(client, jar, timeoutMs);
    if (orderInfo) {
      result.latestOrder = orderInfo.date || 'n/a';
      result.latestOrderId = orderInfo.orderId || 'n/a';
    } else {
      result.latestOrder = 'n/a';
      result.latestOrderId = 'n/a';
    }
    
    log.info(`Latest order: ${result.latestOrder} (ID: ${result.latestOrderId})`);
    
    return result;
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
 * Fetches the latest order info from purchase history.
 * Handles SSO flow: order.my.rakuten.co.jp → login.account.rakuten.com → sessionAlign → redirect back
 * @param {Object} client - HTTP client
 * @param {Object} jar - Cookie jar
 * @param {number} timeoutMs - Request timeout
 * @returns {Promise<Object|null>} { date, orderId } or null if no orders
 */
async function fetchLatestOrder(client, jar, timeoutMs) {
  try {
    log.debug('Fetching order history with SSO flow...');
    
    // Step 1: Initial request to order history - will redirect to SSO authorize
    let response = await client.get(ORDER_HISTORY_URL, {
      timeout: timeoutMs,
      maxRedirects: 10,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
      },
    });
    
    let html = response.data;
    let currentUrl = response.request?.res?.responseUrl || response.config?.url || '';
    log.debug(`Step 1 - URL: ${currentUrl.substring(0, 80)}...`);
    
    // Step 2: If we got SSO authorize page with auto-submit form, handle it manually
    // The page contains: <form id="post_form" action="..." method="POST">...<input name="..." value="...">
    if (html.includes('post_form') || html.includes('login.account.rakuten.com')) {
      log.debug('Got SSO authorize page, parsing auto-submit form...');
      
      // Parse form action and inputs
      const formActionMatch = html.match(/<form[^>]*id=["']?post_form["']?[^>]*action=["']([^"']+)["']/i) ||
                              html.match(/<form[^>]*action=["']([^"']+)["'][^>]*id=["']?post_form["']?/i);
      
      if (formActionMatch) {
        const formAction = formActionMatch[1].replace(/&amp;/g, '&');
        log.debug(`Form action: ${formAction.substring(0, 80)}...`);
        
        // Extract all hidden inputs
        const formData = {};
        const inputRegex = /<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/gi;
        const inputRegex2 = /<input[^>]*value=["']([^"']*)["'][^>]*name=["']([^"']+)["'][^>]*>/gi;
        
        let match;
        while ((match = inputRegex.exec(html)) !== null) {
          formData[match[1]] = match[2];
        }
        while ((match = inputRegex2.exec(html)) !== null) {
          formData[match[2]] = match[1];
        }
        
        log.debug(`Form fields: ${Object.keys(formData).join(', ')}`);
        
        // Submit the form (this goes to sessionAlign)
        if (Object.keys(formData).length > 0) {
          response = await client.post(formAction, new URLSearchParams(formData).toString(), {
            timeout: timeoutMs,
            maxRedirects: 10,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Origin': 'https://login.account.rakuten.com',
              'Referer': currentUrl,
            },
          });
          
          html = response.data;
          currentUrl = response.request?.res?.responseUrl || response.config?.url || '';
          log.debug(`Step 2 (form submit) - URL: ${currentUrl.substring(0, 80)}...`);
          
          // Step 3: Check if we need to handle another form (redirect back to order history)
          if (html.includes('post_form') || html.includes('purchasehistoryapi/redirect')) {
            const formActionMatch2 = html.match(/<form[^>]*action=["']([^"']+)["']/i);
            if (formActionMatch2) {
              const formAction2 = formActionMatch2[1].replace(/&amp;/g, '&');
              log.debug(`Second form action: ${formAction2.substring(0, 80)}...`);
              
              const formData2 = {};
              const inputRegex3 = /<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/gi;
              while ((match = inputRegex3.exec(html)) !== null) {
                formData2[match[1]] = match[2];
              }
              
              if (Object.keys(formData2).length > 0) {
                response = await client.post(formAction2, new URLSearchParams(formData2).toString(), {
                  timeout: timeoutMs,
                  maxRedirects: 10,
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                  },
                });
                
                html = response.data;
                currentUrl = response.request?.res?.responseUrl || response.config?.url || '';
                log.debug(`Step 3 (second form) - URL: ${currentUrl.substring(0, 80)}...`);
              }
            }
          }
        }
      }
    }
    
    // Final check
    log.debug(`Final response length: ${html.length}`);
    
    if (response.status !== 200) {
      log.warn(`Order history returned status ${response.status}`);
      return null;
    }
    
    // Check if we got the order page
    const hasOrderDate = html.includes('注文日');
    const hasOrderNum = html.includes('注文番号');
    log.debug(`Order page check - 注文日: ${hasOrderDate}, 注文番号: ${hasOrderNum}`);
    
    if (!hasOrderDate && !hasOrderNum) {
      const preview = html.substring(0, 500).replace(/\s+/g, ' ');
      log.debug(`Response preview: ${preview}`);
    }
    
    let latestOrderDate = null;
    let latestOrderId = null;
    
    // Extract order date using regex on raw HTML
    // HTML structure: <span>注文日\n<!-- -->\n：</span>\n<span...>2025/12/04(木)</span>
    // The colon ： is full-width Japanese colon (U+FF1A)
    const datePattern = /注文日[\s\S]*?[：:]<\/span>[\s\S]*?<span[^>]*>(\d{4}\/\d{2}\/\d{2})/;
    const dateMatch = html.match(datePattern);
    if (dateMatch) {
      latestOrderDate = dateMatch[1];
      log.debug(`Date pattern matched: ${latestOrderDate}`);
    } else {
      log.debug('Date pattern did NOT match');
      // Debug: Find and log the area around 注文日
      const idx = html.indexOf('注文日');
      if (idx !== -1) {
        log.debug(`Found 注文日 at index ${idx}, snippet: ${html.substring(idx, idx + 200).replace(/\n/g, '\\n')}`);
      }
    }
    
    // Extract order number using regex
    // HTML structure: <span>注文番号\n<!-- -->\n：</span>\n<span...>263885-20251204-0284242812</span>
    const orderPattern = /注文番号[\s\S]*?[：:]<\/span>[\s\S]*?<span[^>]*>(\d+-\d+-(\d+))<\/span>/;
    const orderMatch = html.match(orderPattern);
    if (orderMatch) {
      latestOrderId = orderMatch[2]; // Get just the order ID part (e.g., 0284242812)
      log.debug(`Order pattern matched: ${orderMatch[1]} -> ID: ${latestOrderId}`);
    } else {
      log.debug('Order pattern did NOT match');
    }
    
    if (latestOrderDate || latestOrderId) {
      log.info(`Latest order - date: ${latestOrderDate}, orderId: ${latestOrderId}`);
      return { date: latestOrderDate, orderId: latestOrderId };
    }
    
    log.info('No orders found in purchase history');
    return null;
  } catch (error) {
    log.warn('Failed to fetch order history:', error.message);
    return null;
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

module.exports = {
  captureAccountData,
  captureViaApi,
  captureViaHtml,
  fetchLatestOrder,
  extractPoints,
  RANK_MAP,
};
