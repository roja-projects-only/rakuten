/**
 * =============================================================================
 * SSO FORM HANDLER - Shared SSO auto-submit form parser
 * =============================================================================
 * 
 * Reusable utility for parsing and submitting SSO redirect forms.
 * Used by order history, profile data, and other SSO-protected endpoints.
 * 
 * =============================================================================
 */

const { createLogger } = require('../../../logger');
const { computeCresFromMdataAsync, generateSessionToken } = require('../fingerprinting/challengeGenerator');
const { generateFingerprint } = require('../fingerprinting/ratGenerator');
const { generateFullRatData } = require('../payloads');

const log = createLogger('sso-form');

const LOGIN_BASE = 'https://login.account.rakuten.com';

/**
 * Parses SSO auto-submit form from HTML.
 * Looks for forms with id="post_form" or containing sessionAlign patterns.
 * 
 * @param {string} html - HTML content to parse
 * @returns {{ action: string|null, fields: Object }} Form action URL and hidden input fields
 */
function parseSsoForm(html) {
  // Try multiple patterns to find form action
  const formActionMatch = 
    html.match(/<form[^>]*id=["']?post_form["']?[^>]*action=["']([^"']+)["']/i) ||
    html.match(/<form[^>]*action=["']([^"']+)["'][^>]*id=["']?post_form["']?/i) ||
    html.match(/<form[^>]*action=["']([^"']+)["']/i);
  
  if (!formActionMatch) {
    return { action: null, fields: {} };
  }
  
  const action = formActionMatch[1].replace(/&amp;/g, '&');
  
  // Extract all hidden inputs using multiple patterns
  const fields = {};
  
  // Pattern 1: name before value
  const inputRegex1 = /<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/gi;
  let match;
  while ((match = inputRegex1.exec(html)) !== null) {
    fields[match[1]] = match[2];
  }
  
  // Pattern 2: value before name
  const inputRegex2 = /<input[^>]*value=["']([^"']*)["'][^>]*name=["']([^"']+)["'][^>]*>/gi;
  while ((match = inputRegex2.exec(html)) !== null) {
    fields[match[2]] = match[1];
  }
  
  return { action, fields };
}

/**
 * Checks if HTML contains an SSO redirect form.
 * @param {string} html - HTML content
 * @returns {boolean}
 */
function hasSsoForm(html) {
  return html.includes('post_form') || 
         html.includes('sessionAlign') ||
         html.includes('login.account.rakuten.com');
}

/**
 * Submits SSO form and follows redirects until reaching final page.
 * @param {Object} client - HTTP client
 * @param {string} html - Initial HTML with SSO form
 * @param {string} currentUrl - Current URL for referer
 * @param {number} timeoutMs - Request timeout
 * @param {number} maxIterations - Maximum form submissions
 * @returns {Promise<{ html: string, url: string }>} Final HTML and URL
 */
async function followSsoRedirects(client, html, currentUrl, timeoutMs, maxIterations = 5) {
  let iterations = maxIterations;
  
  while (iterations-- > 0 && hasSsoForm(html)) {
    const { action, fields } = parseSsoForm(html);
    
    if (!action || Object.keys(fields).length === 0) {
      break;
    }
    
    log.debug(`SSO form action: ${action.substring(0, 60)}...`);
    log.debug(`SSO form fields: ${Object.keys(fields).join(', ')}`);
    
    const response = await client.post(action, new URLSearchParams(fields).toString(), {
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
    log.debug(`SSO redirect - URL: ${currentUrl.substring(0, 80)}...`);
  }
  
  return { html, url: currentUrl };
}

/**
 * Skips email verification challenge by POSTing to /v2/verify/email with empty code.
 * Uses POW challenge computation (same as login flow).
 * 
 * @param {Object} client - HTTP client
 * @param {string} verificationUrl - Full verification URL with token param
 * @param {number} timeoutMs - Request timeout
 * @returns {Promise<{ html: string, url: string }|null>} Result after skip, or null if failed
 */
async function skipEmailVerification(client, verificationUrl, timeoutMs) {
  try {
    // Extract main token from URL: /verification/email?token=@St.ott-v2...
    const tokenMatch = verificationUrl.match(/[?&]token=([^&#]+)/);
    if (!tokenMatch) {
      log.warn('[skip-verify] No token found in verification URL');
      return null;
    }
    
    const mainToken = decodeURIComponent(tokenMatch[1]);
    log.debug(`[skip-verify] Main token: ${mainToken.substring(0, 50)}...`);
    
    // Generate correlation ID for this request
    const correlationId = require('crypto').randomUUID();
    
    // Step 1: Call /util/gc to get challenge token and mdata for POW
    let challengeToken = null;
    let cres = null;
    
    try {
      log.debug('[skip-verify] Calling /util/gc to get challenge data');
      const fingerprint = generateFingerprint();
      const ratData = generateFullRatData(correlationId, fingerprint);
      
      const gcUrl = `${LOGIN_BASE}/util/gc?client_id=rakuten_ichiba_top_web&tracking_id=${correlationId}`;
      const gcPayload = {
        page_type: 'VERIFICATION',
        lang: 'en-US',
        rat: ratData,
      };
      
      const gcResponse = await client.post(gcUrl, gcPayload, {
        timeout: timeoutMs,
        headers: {
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Content-Type': 'application/json',
          'Origin': LOGIN_BASE,
          'Referer': verificationUrl,
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        },
      });
      
      log.debug(`[skip-verify] /util/gc response: ${gcResponse.status}`);
      
      if (gcResponse.status === 200 && gcResponse.data?.token) {
        challengeToken = gcResponse.data.token;
        log.debug(`[skip-verify] Got challenge token: ${challengeToken.substring(0, 50)}...`);
        
        // Compute cres from mdata using POW
        if (gcResponse.data?.mdata) {
          try {
            cres = await computeCresFromMdataAsync(gcResponse.data.mdata);
            log.debug(`[skip-verify] Computed cres: ${cres}`);
          } catch (powErr) {
            log.warn(`[skip-verify] POW failed: ${powErr.message}, using fallback`);
            cres = require('crypto').randomBytes(8).toString('hex');
          }
        }
      } else {
        log.warn('[skip-verify] /util/gc did not return token, using generated');
        challengeToken = generateSessionToken('St.ott-v2');
      }
    } catch (err) {
      log.warn('[skip-verify] /util/gc failed:', err.message);
      challengeToken = generateSessionToken('St.ott-v2');
    }
    
    // Fallback cres if not computed
    if (!cres) {
      cres = require('crypto').randomBytes(8).toString('hex');
    }
    
    // Step 2: POST to /v2/verify/email with empty code (= skip)
    const skipUrl = `${LOGIN_BASE}/v2/verify/email`;
    const skipPayload = {
      token: mainToken,
      code: '',  // Empty code = skip verification
      challenge: {
        cres: cres,
        token: challengeToken,
      },
    };
    
    log.debug(`[skip-verify] POSTing to ${skipUrl} with empty code`);
    
    const skipResponse = await client.post(skipUrl, skipPayload, {
      timeout: timeoutMs,
      maxRedirects: 0,  // Don't follow redirects automatically
      validateStatus: (status) => status < 500,  // Accept 2xx, 3xx, 4xx
      headers: {
        'Accept': '*/*',
        'Accept-Language': 'en-US',
        'Content-Type': 'application/json',
        'Origin': LOGIN_BASE,
        'Referer': verificationUrl,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'X-Correlation-Id': correlationId,
      },
    });
    
    log.debug(`[skip-verify] Skip response status: ${skipResponse.status}`);
    
    if (skipResponse.status !== 200) {
      log.warn(`[skip-verify] Unexpected status: ${skipResponse.status}`);
      return null;
    }
    
    // Step 3: Check response for redirect URL or next step
    const responseData = skipResponse.data;
    log.debug(`[skip-verify] Response data: ${JSON.stringify(responseData).substring(0, 200)}...`);
    
    // The response should contain redirect info or we follow SSO again
    // After successful skip, re-calling SSO authorize should bypass verification
    return { 
      html: typeof responseData === 'string' ? responseData : JSON.stringify(responseData), 
      url: skipUrl,
      skipped: true,
    };
    
  } catch (error) {
    log.warn('[skip-verify] Failed to skip email verification:', error.message);
    return null;
  }
}

module.exports = {
  parseSsoForm,
  hasSsoForm,
  followSsoRedirects,
  skipEmailVerification,
};

