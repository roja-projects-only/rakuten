/**
 * =============================================================================
 * PROFILE DATA - Fetch user profile via profile.id.rakuten.co.jp
 * =============================================================================
 * 
 * Handles SSO gateway flow to obtain Bearer token for profile API access.
 * Extracts name, email, phone, DOB, address, and card information.
 * 
 * =============================================================================
 */

const { createLogger } = require('../../../logger');
const { getCookieString } = require('../httpClient');
const { hasSsoForm, followSsoRedirects, skipEmailVerification } = require('./ssoFormHandler');

const log = createLogger('profile-data');

// Profile API URLs
const PROFILE_GATEWAY_START = 'https://profile.id.rakuten.co.jp/gateway/start?clientId=jpn&state=/';
const PROFILE_SUMMARY_API = 'https://profile.id.rakuten.co.jp/v2/member/summary/';
const PROFILE_ADDRESS_API = 'https://profile.id.rakuten.co.jp/v2/member/address';
const PROFILE_CARD_API = 'https://profile.id.rakuten.co.jp/v2/member/card';

/**
 * Extracts Bearer token from various response formats.
 * @param {string|Object} data - Response data (JSON or HTML)
 * @returns {string|null} Bearer token or null
 */
function extractBearerToken(data) {
  if (typeof data === 'object' && data.access_token) {
    return data.access_token;
  }
  
  if (typeof data === 'string') {
    // Try parsing as JSON
    try {
      const parsed = JSON.parse(data);
      if (parsed.access_token) return parsed.access_token;
    } catch (_) {}
    
    // Search in HTML/JS
    const tokenPatterns = [
      /Bearer\s+(@St\.[A-Za-z0-9_.-]+)/,
      /"access_token"\s*:\s*"(@St\.[^"]+)"/,
      /"token"\s*:\s*"(@St\.[^"]+)"/,
      /authorization["']?\s*:\s*["']?Bearer\s+(@St\.[^"'\s]+)/,
      /"accessToken"\s*:\s*"(@St\.[^"]+)"/,
      /data-token=["'](@St\.[^"']+)["']/,
      /value=["'](@St\.[^"']+)["']/,
      /(?:window\.__TOKEN__|TOKEN|accessToken)\s*=\s*["'](@St\.[^"']+)["']/,
    ];
    
    for (const pattern of tokenPatterns) {
      const match = data.match(pattern);
      if (match) return match[1];
    }
    
    // Direct @St. pattern search
    const directMatch = data.match(/@St\.[A-Za-z0-9._-]{50,}/);
    if (directMatch) return directMatch[0];
  }
  
  return null;
}

/**
 * Fetches profile data (name, email, phone, DOB, address) from profile.id.rakuten.co.jp
 * Handles SSO gateway flow to obtain Bearer token for API access.
 * @param {Object} client - HTTP client
 * @param {Object} jar - Cookie jar
 * @param {number} timeoutMs - Request timeout
 * @returns {Promise<Object|null>} Profile data or null on failure
 */
async function fetchProfileData(client, jar, timeoutMs) {
  try {
    log.debug('Fetching profile data via gateway flow...');
    
    // Step 1: Go directly to SSO authorize for profile
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
    
    // Check if redirected to verification/email page - attempt to skip
    if (currentUrl.includes('/verification/email') || currentUrl.includes('/verification/')) {
      log.info('Profile SSO requires email verification - attempting to skip...');
      
      const skipResult = await skipEmailVerification(client, currentUrl, timeoutMs);
      if (!skipResult) {
        log.warn('Could not skip email verification - skipping profile capture');
        return null;
      }
      
      log.info('Email verification skipped, retrying SSO authorize...');
      
      // After successful skip, retry the SSO authorize request
      response = await client.get(ssoAuthorizeUrl, {
        timeout: timeoutMs,
        maxRedirects: 10,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
        },
      });
      
      html = response.data;
      currentUrl = response.request?.res?.responseUrl || response.config?.url || '';
      log.debug(`Profile SSO after skip - URL: ${currentUrl.substring(0, 80)}...`);
      
      // If still on verification page, we failed
      if (currentUrl.includes('/verification/')) {
        log.warn('Still on verification page after skip attempt - skipping profile capture');
        return null;
      }
    }
    
    // Step 2: Handle SSO form redirects
    if (hasSsoForm(html)) {
      const result = await followSsoRedirects(client, html, currentUrl, timeoutMs, 5);
      html = result.html;
      currentUrl = result.url;
    }
    
    // Step 3: Extract authorization code and handle token exchange
    let bearerToken = null;
    
    const codeMatch = currentUrl.match(/[?&]code=([^&]+)/);
    if (codeMatch) {
      log.debug('Got callback with authorization code, following exchange flow...');
      const code = codeMatch[1];
      const stateMatch = currentUrl.match(/[?&]state=([^&]*)/);
      const state = stateMatch ? decodeURIComponent(stateMatch[1]) : '/';
      
      // Call the callback endpoint
      const callbackUrl = `https://profile.id.rakuten.co.jp/gateway/callback?state=${encodeURIComponent(state)}&code=${code}&clientId=jpn`;
      
      const callbackResponse = await client.get(callbackUrl, {
        timeout: timeoutMs,
        maxRedirects: 5,
        headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
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
      
      // Now call the token endpoint
      const tokenUrl = `https://profile.id.rakuten.co.jp/gateway/callback/token?exchange_token=${encodeURIComponent(exchangeToken)}&last_visited_path=/&clientId=jpn`;
      
      const tokenResponse = await client.get(tokenUrl, {
        timeout: timeoutMs,
        maxRedirects: 5,
        headers: { 'Accept': 'application/json, text/html, */*' },
      });
      
      log.debug(`Profile token endpoint - type: ${typeof tokenResponse.data}`);
      bearerToken = extractBearerToken(tokenResponse.data);
      
      if (bearerToken) {
        log.debug(`Found Bearer token: ${bearerToken.substring(0, 50)}...`);
      }
    }
    
    // Try HTML token extraction if not found yet
    if (!bearerToken) {
      bearerToken = extractBearerToken(html);
    }
    
    // Check cookies for token
    if (!bearerToken) {
      const profileCookies = await getCookieString(jar, 'https://profile.id.rakuten.co.jp/');
      const cookieTokenMatch = profileCookies.match(/(?:^|;\s*)(?:access_token|token)=(@St\.[^;]+)/);
      if (cookieTokenMatch) {
        bearerToken = cookieTokenMatch[1];
        log.debug(`Found Bearer token in cookie: ${bearerToken.substring(0, 50)}...`);
      }
    }
    
    // Check if we need to call initiate for proper token
    if (!bearerToken || bearerToken.length < 1000 || !bearerToken.startsWith('@St.default.')) {
      log.debug('Calling gateway/initiate to get proper Bearer token...');
      const initiateUrl = 'https://profile.id.rakuten.co.jp/gateway/initiate?clientId=jpn&last_visited_path=/';
      const initiateResponse = await client.get(initiateUrl, {
        timeout: timeoutMs,
        maxRedirects: 5,
        headers: { 
          'Accept': 'application/json, text/html, */*',
          'Referer': 'https://profile.id.rakuten.co.jp/',
        },
      });
      
      const initiateUrl2 = initiateResponse.request?.res?.responseUrl || initiateResponse.config?.url || '';
      log.debug(`Initiate response status: ${initiateResponse.status}, URL: ${initiateUrl2.substring(0, 80)}...`);
      
      // Check if initiate redirected to verification/login page - try to skip
      if (initiateUrl2.includes('/verification/')) {
        log.info('Profile gateway initiate requires verification - attempting to skip...');
        const skipResult = await skipEmailVerification(client, initiateUrl2, timeoutMs);
        if (!skipResult) {
          log.warn('Could not skip verification during initiate - skipping profile capture');
          return null;
        }
        // Retry initiate after skip
        const retryResponse = await client.get(initiateUrl, {
          timeout: timeoutMs,
          maxRedirects: 5,
          headers: { 
            'Accept': 'application/json, text/html, */*',
            'Referer': 'https://profile.id.rakuten.co.jp/',
          },
        });
        bearerToken = extractBearerToken(retryResponse.data);
      } else if (initiateUrl2.includes('login.account.rakuten.com')) {
        log.warn('Profile gateway requires re-authentication - skipping profile capture');
        return null;
      } else {
        bearerToken = extractBearerToken(initiateResponse.data);
      }
      
      if (!bearerToken) {
        log.warn('Could not obtain Bearer token from gateway/initiate (no token in response)');
        return null;
      }
    }
    
    // Now call the APIs with Bearer token
    const headers = {
      'Accept': '*/*',
      'Accept-Language': 'ja',
      'Authorization': `Bearer ${bearerToken}`,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'Referer': 'https://profile.id.rakuten.co.jp/',
      'serviceuuid': 'c2ccb1a9-daea-4505-89ae-6bad6c9af5f2',
      'x-client-id': 'f2ce0768-717c-4f33-be14-9149f5b9ad30',
    };
    
    log.debug(`Using Bearer token: ${bearerToken.substring(0, 60)}... (${bearerToken.length} chars)`);
    
    // Fetch all profile data in parallel
    const [summaryResult, addressResult, cardsResult] = await Promise.allSettled([
      client.get(PROFILE_SUMMARY_API, { timeout: timeoutMs, headers }),
      client.get(PROFILE_ADDRESS_API, { timeout: timeoutMs, headers }),
      client.get(PROFILE_CARD_API, { timeout: timeoutMs, headers }),
    ]);
    
    const summary = summaryResult.status === 'fulfilled' && summaryResult.value.status === 200 
      ? summaryResult.value.data : null;
    const address = addressResult.status === 'fulfilled' && addressResult.value.status === 200
      ? (Array.isArray(addressResult.value.data) ? addressResult.value.data[0] : addressResult.value.data) : null;
    const cards = cardsResult.status === 'fulfilled' && cardsResult.value.status === 200
      ? (Array.isArray(cardsResult.value.data) ? cardsResult.value.data : [cardsResult.value.data]) : null;
    
    if (summary) log.debug(`Summary API response: ${JSON.stringify(summary).substring(0, 200)}...`);
    if (address) log.debug(`Address API response: ${JSON.stringify(address).substring(0, 200)}...`);
    if (cards) log.info(`Found ${cards.length} card(s) on account`);
    
    if (!summary && !address && !cards) {
      log.warn('Profile APIs returned no data despite having token');
      return null;
    }
    
    // Build result
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
      cards: cards ? cards.map(c => ({
        brand: c.brandName || null,
        owner: c.ownerName || null,
        expiry: (c.expireYear && c.expireMonth) ? `${c.expireMonth}/${c.expireYear}` : null,
        last4: c.numberLast || null,
        isPrimary: c.isPrimary || false,
      })) : null,
    };
    
    const primaryPhone = result.mobilePhone || result.homePhone || 'n/a';
    const cardCount = result.cards ? result.cards.length : 0;
    log.info(`Profile captured - name: ${result.name} (${result.nameKana}), email: ${result.email}, dob: ${result.dob}, phone: ${primaryPhone}, cards: ${cardCount}`);
    
    return result;
  } catch (error) {
    log.warn('Failed to fetch profile data:', error.message);
    return null;
  }
}

module.exports = {
  fetchProfileData,
  extractBearerToken,
  PROFILE_SUMMARY_API,
  PROFILE_ADDRESS_API,
  PROFILE_CARD_API,
};

