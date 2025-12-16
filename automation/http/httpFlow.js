/**
 * =============================================================================
 * HTTP FLOW - HTTP-BASED RAKUTEN LOGIN FLOW
 * =============================================================================
 * 
 * Implements the Rakuten login flow using pure HTTP requests instead of Puppeteer.
 * Mimics browser behavior with proper headers, cookies, and fingerprinting.
 * 
 * Flow:
 * 1. Navigate to login page (GET) - establish session
 * 2. Submit email (POST /v2/login/start or similar)
 * 3. Submit password (POST /v2/login/complete)
 * 4. Follow redirects to get final authenticated state
 * 
 * =============================================================================
 */

const FormData = require('form-data');
const { extractFormFields, isRedirect, getRedirectUrl } = require('./htmlAnalyzer');
const { generateRatData, updateRatState, generateCorrelationId } = require('./fingerprinting/ratGenerator');
const { generateBioData, humanDelay } = require('./fingerprinting/bioGenerator');
const { generateChallengeObject, generateTrackingId, generateSessionToken } = require('./fingerprinting/challengeGenerator');
const { touchSession } = require('./sessionManager');
const { createLogger } = require('../../logger');

const log = createLogger('http-flow');

// Rakuten login endpoints
const LOGIN_BASE = 'https://login.account.rakuten.com';
const LOGIN_AUTHORIZE_PATH = '/sso/authorize';
const LOGIN_START_PATH = '/v2/login/start';
const LOGIN_COMPLETE_PATH = '/v2/login/complete';

/**
 * Navigates to login page and establishes session.
 * Equivalent to rakutenFlow.navigateToLogin()
 * 
 * @param {Object} session - HTTP session object
 * @param {string} targetUrl - Full login URL with OAuth parameters
 * @param {number} timeoutMs - Request timeout
 * @returns {Promise<Object>} Response object with HTML and cookies
 */
async function navigateToLogin(session, targetUrl, timeoutMs) {
  const { client } = session;
  
  log.info('Navigating to login page...');
  touchSession(session);
  
  try {
    const response = await client.get(targetUrl, {
      timeout: timeoutMs,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8',
        'Cache-Control': 'max-age=0',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    });
    
    log.info(`Loaded login page: ${response.status}`);
    
    // Extract any hidden form fields (CSRF tokens, etc.)
    const formFields = extractFormFields(response.data);
    
    return {
      status: response.status,
      html: response.data,
      formFields,
      url: response.request.res.responseUrl || targetUrl,
    };
  } catch (error) {
    log.error('Failed to navigate to login page:', error.message);
    throw new Error(`Navigation failed: ${error.message}`);
  }
}

/**
 * Submits email/username to initiate login.
 * Equivalent to rakutenFlow.submitEmailStep()
 * 
 * @param {Object} session - HTTP session object
 * @param {string} email - Email/username
 * @param {Object} context - Context from navigation (formFields, etc.)
 * @param {number} timeoutMs - Request timeout
 * @returns {Promise<Object>} Response with token for next step
 */
async function submitEmailStep(session, email, context, timeoutMs) {
  const { client, jar } = session;
  
  log.info('Submitting email step...');
  touchSession(session);
  
  // Generate fingerprinting data
  const correlationId = generateCorrelationId();
  const trackingId = generateTrackingId();
  const ratData = generateRatData({ correlationId });
  const bioData = generateBioData({ username: email });
  
  // Add human delay before submission
  await humanDelay(800, 1500);
  
  try {
    // Build request payload
    // NOTE: This structure is a PLACEHOLDER - must be replaced with actual format
    // captured from Chrome DevTools observation of real login requests
    const payload = {
      user_id: email,
      authorize_request: context.formFields.authorize_request || '',
      client_id: 'rakuten_ichiba_top_web',
      tracking_id: trackingId,
      // Add fingerprinting data if required
      rat: JSON.stringify(ratData),
      bio: JSON.stringify(bioData),
      ...context.formFields, // Include any hidden fields
    };
    
    const url = `${LOGIN_BASE}${LOGIN_START_PATH}`;
    
    const response = await client.post(url, payload, {
      timeout: timeoutMs,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        'Origin': LOGIN_BASE,
        'Referer': `${LOGIN_BASE}${LOGIN_AUTHORIZE_PATH}`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'X-Correlation-Id': correlationId,
      },
    });
    
    log.info(`Email step response: ${response.status}`);
    
    // Extract token for password step
    const token = response.data?.token || response.data?.session_token;
    
    if (!token) {
      log.warn('No token received from email step');
    }
    
    return {
      status: response.status,
      data: response.data,
      token,
      correlationId,
      trackingId,
    };
  } catch (error) {
    log.error('Email step failed:', error.message);
    if (error.response) {
      log.debug(`Response status: ${error.response.status}`);
      log.debug(`Response data: ${JSON.stringify(error.response.data)}`);
    }
    throw new Error(`Email submission failed: ${error.message}`);
  }
}

/**
 * Submits password to complete authentication.
 * Equivalent to rakutenFlow.submitPasswordStep()
 * 
 * @param {Object} session - HTTP session object
 * @param {string} password - Password
 * @param {Object} emailStepResult - Result from email step (token, etc.)
 * @param {string} username - Username for bio generation
 * @param {number} timeoutMs - Request timeout
 * @returns {Promise<Object>} Final authentication response
 */
async function submitPasswordStep(session, password, emailStepResult, username, timeoutMs) {
  const { client } = session;
  
  log.info('Submitting password step...');
  touchSession(session);
  
  // Generate fingerprinting data
  const { correlationId, trackingId, token } = emailStepResult;
  const ratData = updateRatState(generateRatData({ correlationId }), 'password_submit');
  const bioData = generateBioData({ username, password });
  const challenge = generateChallengeObject({ username, previousToken: token });
  
  // Add human delay before submission
  await humanDelay(1000, 2000);
  
  try {
    // Build request payload
    // NOTE: This structure is a PLACEHOLDER - must be replaced with actual format
    // captured from Chrome DevTools observation of /v2/login/complete request
    const payload = {
      user_key: password,
      token: token || generateSessionToken(),
      trust_device: true,
      revoke_token: null,
      challenge: challenge,
      // Add fingerprinting data if required
      rat: JSON.stringify(ratData),
      bio: JSON.stringify(bioData),
    };
    
    const url = `${LOGIN_BASE}${LOGIN_COMPLETE_PATH}`;
    
    const response = await client.post(url, payload, {
      timeout: timeoutMs,
      maxRedirects: 0, // Don't follow redirects automatically
      validateStatus: (status) => status < 600, // Accept all statuses
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        'Origin': LOGIN_BASE,
        'Referer': `${LOGIN_BASE}${LOGIN_AUTHORIZE_PATH}`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'X-Correlation-Id': correlationId,
      },
    });
    
    log.info(`Password step response: ${response.status}`);
    
    // Store response details for outcome analysis
    const result = {
      status: response.status,
      statusText: response.statusText,
      data: response.data,
      headers: response.headers,
      url: response.request?.res?.responseUrl || url,
    };
    
    // If redirect, follow it to get final URL
    if (isRedirect(response)) {
      const redirectUrl = getRedirectUrl(response);
      if (redirectUrl) {
        log.info(`Following redirect to: ${redirectUrl}`);
        try {
          const finalResponse = await followRedirects(session, redirectUrl, timeoutMs);
          result.finalUrl = finalResponse.url;
          result.finalStatus = finalResponse.status;
        } catch (redirectError) {
          log.warn('Failed to follow redirect:', redirectError.message);
        }
      }
    }
    
    return result;
  } catch (error) {
    log.error('Password step failed:', error.message);
    if (error.response) {
      log.debug(`Response status: ${error.response.status}`);
      log.debug(`Response data: ${JSON.stringify(error.response.data)}`);
      
      // Return error response for analysis
      return {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data,
        headers: error.response.headers,
        url: error.config?.url || `${LOGIN_BASE}${LOGIN_COMPLETE_PATH}`,
        error: true,
      };
    }
    throw new Error(`Password submission failed: ${error.message}`);
  }
}

/**
 * Follows redirect chain to get final authenticated URL.
 * @param {Object} session - HTTP session
 * @param {string} redirectUrl - Initial redirect URL
 * @param {number} timeoutMs - Timeout
 * @param {number} maxDepth - Max redirect depth
 * @returns {Promise<Object>} Final response
 */
async function followRedirects(session, redirectUrl, timeoutMs, maxDepth = 5) {
  const { client } = session;
  let currentUrl = redirectUrl;
  let depth = 0;
  
  while (depth < maxDepth) {
    touchSession(session);
    
    try {
      const response = await client.get(currentUrl, {
        timeout: timeoutMs,
        maxRedirects: 0,
        validateStatus: (status) => status < 600,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'cross-site',
        },
      });
      
      // If not a redirect, we've reached the final destination
      if (!isRedirect(response)) {
        return {
          status: response.status,
          url: response.request?.res?.responseUrl || currentUrl,
          html: response.data,
        };
      }
      
      // Continue following redirects
      currentUrl = getRedirectUrl(response);
      if (!currentUrl) {
        break;
      }
      
      depth++;
      log.debug(`Redirect ${depth}: ${currentUrl}`);
      
    } catch (error) {
      log.warn(`Redirect follow error at depth ${depth}:`, error.message);
      throw error;
    }
  }
  
  throw new Error('Max redirect depth reached');
}

/**
 * Performs a simple delay to mimic human behavior.
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  navigateToLogin,
  submitEmailStep,
  submitPasswordStep,
  followRedirects,
  sleep,
};
