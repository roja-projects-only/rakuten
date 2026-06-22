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

const crypto = require('crypto');
const { createLogger } = require('../logger');
const { computeCresFromMdataAsync, generateSessionToken, generateRandomCres } = require('../fingerprinting/challengeGenerator');
const { generateSessionFingerprint, generateProfile } = require('../fingerprinting/browserProfile');
const { generateFullRatData } = require('../payloads');

const log = createLogger('sso-form');

const LOGIN_BASE = 'https://login.account.rakuten.com';

/**
 * Builds a challenge payload (cres + challengeToken) by calling /util/gc
 * and computing Proof-of-Work. Shared across skip operations.
 * Falls back to random cres + generated token if /util/gc is unavailable.
 *
 * @param {Object} client - HTTP client
 * @param {Object} options - Configuration
 * @param {string} [options.gcClientId='rakuten_myr_jp_web'] - Client ID for /util/gc
 * @param {string} [options.gcPageType='DEFAULT_P'] - Page type for /util/gc
 * @param {Object} [options.fingerprint] - Session fingerprint (for rat data)
 * @param {Object} [options.profile] - Browser profile (for rat data)
 * @param {string} [options.referer] - Referer URL for /util/gc
 * @param {number} timeoutMs - Request timeout
 * @param {string} logLabel - Label for log messages (e.g. 'skip-verify', 'skip-upgrade')
 * @returns {Promise<{cres: string, challengeToken: string, correlationId: string}>}
 *   Challenge payload data (infallible — always returns via fallback chain)
 */
async function buildChallengePayload(client, options = {}, timeoutMs, logLabel) {
  const { gcClientId = 'rakuten_myr_jp_web', gcPageType = 'DEFAULT_P' } = options;
  const correlationId = crypto.randomUUID();
  const fingerprint = options.fingerprint || generateSessionFingerprint();
  const profile = options.profile || generateProfile();
  const ratData = generateFullRatData(correlationId, fingerprint, profile);

  let challengeToken = null;
  let mdata = null;

  log.debug(`[${logLabel}] Calling /util/gc for challenge data (client_id=${gcClientId}, page_type=${gcPageType})...`);

  try {
    const gcUrl = `${LOGIN_BASE}/util/gc?client_id=${gcClientId}&tracking_id=${correlationId}`;
    const gcPayload = {
      page_type: gcPageType,
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
        'Referer': options.referer || `${LOGIN_BASE}/`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
    });

    log.debug(`[${logLabel}] /util/gc response: ${gcResponse.status}`);

    if (gcResponse.status === 200 && gcResponse.data?.token) {
      challengeToken = gcResponse.data.token;
      mdata = gcResponse.data.mdata;
      log.debug(`[${logLabel}] Got challenge token: ${challengeToken.substring(0, 50)}...`);
    } else {
      log.debug(`[${logLabel}] /util/gc data: ${JSON.stringify(gcResponse.data).substring(0, 200)}`);
    }
  } catch (err) {
    log.debug(`[${logLabel}] /util/gc failed: ${err.message}`);
  }

  // Fallback challenge token if /util/gc failed
  if (!challengeToken) {
    log.debug(`[${logLabel}] Using generated challenge token`);
    challengeToken = generateSessionToken('St.ott-v2');
  }

  // Compute cres from mdata or generate random
  let cres = null;

  if (mdata) {
    try {
      cres = await computeCresFromMdataAsync(mdata);
      log.debug(`[${logLabel}] Computed cres: ${cres}`);
    } catch (err) {
      log.debug(`[${logLabel}] POW failed: ${err.message}`);
    }
  }

  if (!cres) {
    cres = generateRandomCres();
    log.debug(`[${logLabel}] Using random cres: ${cres}`);
  }

  return { cres, challengeToken, correlationId };
}

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
 * Extracts challenge token from verification page and computes POW.
 * 
 * @param {Object} client - HTTP client
 * @param {string} verificationUrl - Full verification URL with token param
 * @param {number} timeoutMs - Request timeout
 * @param {Object} [options] - Options for fingerprint/profile injection
 * @returns {Promise<{ html: string, url: string, skipped: boolean }|null>} Result after skip, or null if failed
 */
async function skipEmailVerification(client, verificationUrl, timeoutMs, options = {}) {
  try {
    // Extract main token from URL: /verification/email?token=@St.ott-v2...
    const tokenMatch = verificationUrl.match(/[?&]token=([^&#]+)/);
    if (!tokenMatch) {
      log.warn('[skip-verify] No token found in verification URL');
      return null;
    }

    const mainToken = decodeURIComponent(tokenMatch[1]);
    log.debug(`[skip-verify] Main token: ${mainToken.substring(0, 50)}...`);

    // Build challenge payload (cres + token) from /util/gc + POW
    const { cres, challengeToken, correlationId } = await buildChallengePayload(client, {
      ...options,
      gcClientId: 'rakuten_ichiba_top_web',
      gcPageType: 'LOGIN_START',
      referer: `${LOGIN_BASE}/`,
    }, timeoutMs, 'skip-verify');

    // POST to /v2/verify/email with empty code (= skip)
    const skipUrl = `${LOGIN_BASE}/v2/verify/email`;
    const skipPayload = {
      token: mainToken,
      code: '',  // Empty code = skip verification
      challenge: {
        cres: cres,
        token: challengeToken,
      },
    };

    log.debug(`[skip-verify] POSTing to ${skipUrl}`);

    const skipResponse = await client.post(skipUrl, skipPayload, {
      timeout: timeoutMs,
      maxRedirects: 0,
      validateStatus: (status) => status < 500,
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

    log.debug(`[skip-verify] Response status: ${skipResponse.status}`);

    if (skipResponse.status !== 200) {
      log.warn(`[skip-verify] Skip failed with status: ${skipResponse.status}`);
      if (skipResponse.data) {
        log.debug(`[skip-verify] Response: ${JSON.stringify(skipResponse.data).substring(0, 200)}`);
      }
      return null;
    }

    log.info('[skip-verify] Email verification skipped successfully');

    return { 
      html: typeof skipResponse.data === 'string' ? skipResponse.data : JSON.stringify(skipResponse.data), 
      url: skipUrl,
      skipped: true,
    };

  } catch (error) {
    log.warn('[skip-verify] Failed to skip email verification:', error.message);
    return null;
  }
}

/**
 * Skips the session upgrade challenge by POSTing to /v2/login/upgrade.
 * The session upgrade page prompts the user to upgrade/verify their session
 * before accessing profile data. This function generates a challenge payload
 * and submits it with skip=true to bypass the prompt.
 *
 * @param {Object} client - HTTP client
 * @param {string} upgradeUrl - Full session/upgrade URL with token param
 * @param {number} timeoutMs - Request timeout
 * @param {Object} [options] - Options for fingerprint/profile injection
 * @returns {Promise<{ html: string, url: string, skipped: boolean }|null>}
 *   Result after skip, or null if failed
 */
async function skipSessionUpgrade(client, upgradeUrl, timeoutMs, options = {}) {
  try {
    // Extract main token from URL: /session/upgrade?token=@St.ott-v2...
    const tokenMatch = upgradeUrl.match(/[?&]token=([^&#]+)/);
    if (!tokenMatch) {
      log.warn('[skip-upgrade] No token found in session upgrade URL');
      return null;
    }

    const mainToken = decodeURIComponent(tokenMatch[1]);
    log.debug(`[skip-upgrade] Main token: ${mainToken.substring(0, 50)}...`);

    // Build challenge payload (cres + token) from /util/gc + POW
    // Uses profile-flow client_id and page_type (from HAR analysis)
    const { cres, challengeToken, correlationId } = await buildChallengePayload(client, {
      ...options,
      gcClientId: 'rakuten_myr_jp_web',
      gcPageType: 'DEFAULT_P',
      referer: upgradeUrl,
    }, timeoutMs, 'skip-upgrade');

    // POST to /v2/login/upgrade with skip + challenge
    const skipUrl = `${LOGIN_BASE}/v2/login/upgrade`;
    const skipPayload = {
      token: mainToken,
      skip: true,
      challenge: {
        cres: cres,
        token: challengeToken,
      },
    };

    log.debug(`[skip-upgrade] POSTing to ${skipUrl}`);

    const skipResponse = await client.post(skipUrl, skipPayload, {
      timeout: timeoutMs,
      maxRedirects: 0,
      validateStatus: (status) => status < 500,
      headers: {
        'Accept': '*/*',
        'Accept-Language': 'en-US',
        'Content-Type': 'application/json',
        'Origin': LOGIN_BASE,
        'Referer': upgradeUrl,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'X-Correlation-Id': correlationId,
      },
    });

    log.debug(`[skip-upgrade] Response status: ${skipResponse.status}`);

    if (skipResponse.status !== 200) {
      log.warn(`[skip-upgrade] Skip failed with status: ${skipResponse.status}`);
      if (skipResponse.data) {
        log.debug(`[skip-upgrade] Response: ${JSON.stringify(skipResponse.data).substring(0, 200)}`);
      }
      return null;
    }

    log.info('[skip-upgrade] Session upgrade skipped successfully');

    return {
      html: typeof skipResponse.data === 'string' ? skipResponse.data : JSON.stringify(skipResponse.data),
      url: skipUrl,
      skipped: true,
    };

  } catch (error) {
    log.warn('[skip-upgrade] Failed to skip session upgrade:', error.message);
    return null;
  }
}

module.exports = {
  parseSsoForm,
  hasSsoForm,
  followSsoRedirects,
  skipEmailVerification,
  skipSessionUpgrade,
};
