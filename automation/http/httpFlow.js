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
 * Payload structures captured from Chrome DevTools - Dec 2025
 * 
 * =============================================================================
 */

const { extractFormFields, isRedirect, getRedirectUrl } = require('./htmlAnalyzer');
const { generateRatData, generateCorrelationId, generateFingerprint } = require('./fingerprinting/ratGenerator');
const { generateBioData, humanDelay } = require('./fingerprinting/bioGenerator');
const { generateChallengeToken, generateSessionToken } = require('./fingerprinting/challengeGenerator');
const { touchSession } = require('./sessionManager');
const { createLogger } = require('../../logger');

const log = createLogger('http-flow');

// Rakuten login endpoints
const LOGIN_BASE = 'https://login.account.rakuten.com';
const LOGIN_AUTHORIZE_PATH = '/sso/authorize';
const LOGIN_INIT_PATH = '/v2/login';
const LOGIN_START_PATH = '/v2/login/start';
const LOGIN_COMPLETE_PATH = '/v2/login/complete';
const CHALLENGER_API = 'https://challenger.api.global.rakuten.com/v1.0/p';

/**
 * Builds the authorize_request object used in login requests.
 * Captured from real Chrome DevTools requests.
 */
function buildAuthorizeRequest() {
  return {
    client_id: 'rakuten_ichiba_top_web',
    redirect_uri: 'https://www.rakuten.co.jp/',
    scope: 'openid',
    response_type: 'code',
    ui_locales: 'en-US',
    state: '',
    max_age: null,
    nonce: '',
    display: 'page',
    code_challenge: '',
    code_challenge_method: '',
    r10_required_claims: '',
    r10_audience: 'jid',
    r10_jid_service_id: 'omnit246',
    r10_preferred_authentication: null,
    r10_guest_login: false,
    r10_disable_intra: true,
    r10_force_account: null,
    r10_own_scope: null,
    r10_rejection: null,
    token: null,
  };
}

/**
 * Generates full RAT (Rakuten Analytics Tracking) fingerprint data.
 * Structure captured from real Chrome DevTools requests - Dec 2025
 * Total payload size should be ~8500 bytes to match real requests
 */
function generateFullRatData(correlationId, fingerprint) {
  return {
    components: {
      fonts: {
        value: [
          'Agency FB', 'Calibri', 'Century', 'Century Gothic', 'Franklin Gothic',
          'Haettenschweiler', 'Lucida Bright', 'Lucida Sans', 'MS Outlook',
          'MS Reference Specialty', 'MS UI Gothic', 'MT Extra', 'Marlett',
          'Monotype Corsiva', 'Pristina', 'Segoe UI Light'
        ],
        duration: Math.floor(Math.random() * 20) + 80,
      },
      domBlockers: { duration: Math.floor(Math.random() * 20) + 70 },
      fontPreferences: {
        value: {
          default: 149.3125, apple: 149.3125, serif: 149.3125, sans: 144.015625,
          mono: 121.515625, min: 9.34375, system: 147.859375
        },
        duration: Math.floor(Math.random() * 20) + 75,
      },
      audio: { value: 124.04347527516074, duration: 1 },
      screenFrame: { value: [0, 0, 0, 0], duration: 0 },
      osCpu: { duration: 0 },
      languages: { value: [['en-US']], duration: 0 },
      colorDepth: { value: 24, duration: 0 },
      deviceMemory: { value: 8, duration: 0 },
      screenResolution: { value: [1920, 1080], duration: 0 },
      hardwareConcurrency: { value: 12, duration: 0 },
      timezone: { value: 'Asia/Manila', duration: 4 },
      sessionStorage: { value: true, duration: 0 },
      localStorage: { value: true, duration: 0 },
      indexedDB: { value: true, duration: 0 },
      openDatabase: { value: false, duration: 0 },
      cpuClass: { duration: 0 },
      platform: { value: 'Win32', duration: 0 },
      plugins: {
        value: [
          { name: 'PDF Viewer', description: 'Portable Document Format', mimeTypes: [{ type: 'application/pdf', suffixes: 'pdf' }, { type: 'text/pdf', suffixes: 'pdf' }] },
          { name: 'Chrome PDF Viewer', description: 'Portable Document Format', mimeTypes: [{ type: 'application/pdf', suffixes: 'pdf' }, { type: 'text/pdf', suffixes: 'pdf' }] },
          { name: 'Chromium PDF Viewer', description: 'Portable Document Format', mimeTypes: [{ type: 'application/pdf', suffixes: 'pdf' }, { type: 'text/pdf', suffixes: 'pdf' }] },
          { name: 'Microsoft Edge PDF Viewer', description: 'Portable Document Format', mimeTypes: [{ type: 'application/pdf', suffixes: 'pdf' }, { type: 'text/pdf', suffixes: 'pdf' }] },
          { name: 'WebKit built-in PDF', description: 'Portable Document Format', mimeTypes: [{ type: 'application/pdf', suffixes: 'pdf' }, { type: 'text/pdf', suffixes: 'pdf' }] },
        ],
        duration: 0,
      },
      touchSupport: { value: { maxTouchPoints: 0, touchEvent: false, touchStart: false }, duration: 0 },
      vendor: { value: 'Google Inc.', duration: 0 },
      vendorFlavors: { value: ['chrome'], duration: 0 },
      cookiesEnabled: { value: true, duration: 0 },
      colorGamut: { value: 'srgb', duration: 0 },
      invertedColors: { duration: 0 },
      forcedColors: { value: false, duration: 0 },
      monochrome: { value: 0, duration: 0 },
      contrast: { value: 0, duration: 0 },
      reducedMotion: { value: false, duration: 0 },
      hdr: { value: false, duration: 0 },
      math: {
        value: {
          acos: 1.4473588658278522, acosh: 709.889355822726, acoshPf: 355.291251501643,
          asin: 0.12343746096704435, asinh: 0.881373587019543, asinhPf: 0.8813735870195429,
          atanh: 0.5493061443340548, atanhPf: 0.5493061443340548, atan: 0.4636476090008061,
          sin: 0.8178819121159085, sinh: 1.1752011936438014, sinhPf: 2.534342107873324,
          cos: -0.8390715290095377, cosh: 1.5430806348152437, coshPf: 1.5430806348152437,
          tan: -1.4214488238747245, tanh: 0.7615941559557649, tanhPf: 0.7615941559557649,
          exp: 2.718281828459045, expm1: 1.718281828459045, expm1Pf: 1.718281828459045,
          log1p: 2.3978952727983707, log1pPf: 2.3978952727983707, powPI: 1.9275814160560206e-50
        },
        duration: 1,
      },
      videoCard: {
        value: {
          vendor: 'Google Inc. (NVIDIA)',
          renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Ti (0x00001B06) Direct3D11 vs_5_0 ps_5_0, D3D11)'
        },
        duration: 5,
      },
      pdfViewerEnabled: { value: true, duration: 0 },
      architecture: { value: 255, duration: 0 },
      C_webRTC: {
        value: {
          mediaDevices: [{ kind: 'audioinput' }, { kind: 'audiooutput' }, { kind: 'videoinput' }],
          mediaCapabilities: {
            audio: [
              { channels: 2, mimeType: 'audio/opus', clockRates: [48000], feedbackSupport: ['transport-cc'], sdpFmtpLine: ['minptime=10', 'useinbandfec=1'] },
              { channels: 2, mimeType: 'audio/red', clockRates: [48000], sdpFmtpLine: ['111/111'] },
              { channels: 1, mimeType: 'audio/G722', clockRates: [8000] },
              { channels: 1, mimeType: 'audio/PCMU', clockRates: [8000] },
              { channels: 1, mimeType: 'audio/PCMA', clockRates: [8000] },
              { channels: 1, mimeType: 'audio/CN', clockRates: [8000] },
              { channels: 1, mimeType: 'audio/telephone-event', clockRates: [48000, 8000] }
            ],
            video: [
              { mimeType: 'video/VP8', clockRates: [90000], feedbackSupport: ['goog-remb', 'transport-cc', 'ccm fir', 'nack', 'nack pli'] },
              { mimeType: 'video/rtx', clockRates: [90000] },
              { mimeType: 'video/VP9', clockRates: [90000], feedbackSupport: ['goog-remb', 'transport-cc', 'ccm fir', 'nack', 'nack pli'], sdpFmtpLine: ['profile-id=0', 'profile-id=2', 'profile-id=1', 'profile-id=3'] },
              { mimeType: 'video/H264', clockRates: [90000], feedbackSupport: ['goog-remb', 'transport-cc', 'ccm fir', 'nack', 'nack pli'], sdpFmtpLine: ['level-asymmetry-allowed=1', 'packetization-mode=1', 'profile-level-id=42001f', 'packetization-mode=0', 'profile-level-id=42e01f', 'profile-level-id=4d001f', 'profile-level-id=f4001f', 'profile-level-id=64001f'] },
              { mimeType: 'video/AV1', clockRates: [90000], feedbackSupport: ['goog-remb', 'transport-cc', 'ccm fir', 'nack', 'nack pli'], sdpFmtpLine: ['level-idx=5', 'profile=0', 'tier=0', 'profile=1'] },
              { mimeType: 'video/H264', clockRates: [90000], feedbackSupport: ['goog-remb', 'transport-cc', 'ccm fir', 'nack', 'nack pli'], sdpFmtpLine: ['level-asymmetry-allowed=1', 'packetization-mode=1', 'profile-level-id=64001f', 'packetization-mode=0'] },
              { mimeType: 'video/H265', clockRates: [90000], feedbackSupport: ['goog-remb', 'transport-cc', 'ccm fir', 'nack', 'nack pli'], sdpFmtpLine: ['level-id=180', 'profile-id=1', 'tier-flag=0', 'tx-mode=SRST', 'profile-id=2'] },
              { mimeType: 'video/red', clockRates: [90000] },
              { mimeType: 'video/ulpfec', clockRates: [90000] },
              { mimeType: 'video/flexfec-03', clockRates: [90000], feedbackSupport: ['goog-remb', 'transport-cc'], sdpFmtpLine: ['repair-window=10000000'] }
            ]
          }
        },
        duration: Math.floor(Math.random() * 100) + 500,
      },
      C_codecs: {
        value: [
          'video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="avc1.58A01E"',
          'video/mp4; codecs="avc1.4D401E"', 'video/mp4; codecs="avc1.640028"',
          'video/mp4; codecs="hev1.1.6.L93.B0"', 'video/mp4; codecs="hvc1.1.6.L93.B0"',
          'video/mp4; codecs="av01.0.01M.08"', 'video/webm; codecs="vp8"',
          'video/webm; codecs="vp9"', 'video/webm; codecs="av01.0.01M.08"',
          'audio/mp4; codecs="mp4a.40.2"', 'audio/mp4; codecs="mp4a.40.5"',
          'audio/mp4; codecs="mp4a.67"', 'audio/mp4; codecs="opus"',
          'audio/mp4; codecs="flac"', 'audio/webm; codecs="opus"',
          'audio/webm; codecs="vorbis"'
        ],
        duration: 1,
      },
      C_sensors: {
        value: { hasOrientationApi: true, hasAccelerometerApi: true, hasOrientationChanged: false, hasAccelerationChanged: false },
        duration: Math.floor(Math.random() * 50) + 280,
      },
    },
    hash: fingerprint,
    hashesOther: {
      hashHardware: generateFingerprint(),
    },
  };
}

/**
 * Generates bio data matching the real request format.
 */
function generateRealBioData(startTime) {
  return {
    kp: Math.floor(Math.random() * 20) + 10, // keypresses
    mc: Math.floor(Math.random() * 3) + 1,   // mouse clicks
    mm: Math.floor(Math.random() * 50) + 20, // mouse movements
    start_time: startTime,
    ts: 0,
  };
}

/**
 * Navigates to login page and establishes session.
 * Equivalent to rakutenFlow.navigateToLogin()
 * 
 * @param {Object} session - HTTP session object
 * @param {string} targetUrl - Full login URL with OAuth parameters
 * @param {number} timeoutMs - Request timeout
 * @returns {Promise<Object>} Response object with HTML, cookies, and correlation ID
 */
async function navigateToLogin(session, targetUrl, timeoutMs) {
  const { client } = session;
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
    await humanDelay(300, 600);
    
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
 * Equivalent to rakutenFlow.submitEmailStep()
 * 
 * @param {Object} session - HTTP session object
 * @param {string} email - Email/username
 * @param {Object} context - Context from navigation (correlationId, etc.)
 * @param {number} timeoutMs - Request timeout
 * @returns {Promise<Object>} Response with token for next step
 */
async function submitEmailStep(session, email, context, timeoutMs) {
  const { client } = session;
  const { correlationId } = context;
  
  log.debug('Submitting email');
  touchSession(session);
  
  // Generate fingerprinting data
  const startTime = Date.now();
  const fingerprint = generateFingerprint();
  const ratData = generateFullRatData(correlationId, fingerprint);
  const bioData = generateRealBioData(startTime);
  
  // Add human delay before submission
  await humanDelay(800, 1500);
  
  // Step 1: Call /util/gc to get challenge token
  // NOTE: The /util/gc response includes:
  // - token: Used for challenge.token in login request
  // - cdata: Encrypted challenge data
  // - mdata: Contains {mask, key, seed} used to compute cres
  // The cres (challenge response) must be computed client-side using mdata
  // This requires implementing the same algorithm as Rakuten's Elm JS
  let challengeToken = null;
  let gcResponse = null;
  let cres = null;
  try {
    log.debug('[email-step] Calling /util/gc to get challenge token');
    const gcUrl = `${LOGIN_BASE}/util/gc?client_id=rakuten_ichiba_top_web&tracking_id=${correlationId}`;
    const gcPayload = {
      page_type: 'LOGIN_START',
      lang: 'en-US',
      rat: ratData,
    };
    
    gcResponse = await client.post(gcUrl, gcPayload, {
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
    
    log.debug(`[email-step] /util/gc response: ${gcResponse.status}`);
    
    if (gcResponse.status === 200 && gcResponse.data?.token) {
      challengeToken = gcResponse.data.token;
      log.debug(`[email-step] Got challenge token from /util/gc: ${challengeToken.substring(0, 50)}...`);
      
      // Compute cres from mdata
      if (gcResponse.data?.mdata) {
        cres = generateChallengeToken({ type: 'cres', mdata: gcResponse.data.mdata });
        log.debug(`[email-step] Computed cres from mdata: ${cres}`);
      }
    } else {
      log.warn('[email-step] /util/gc did not return a token, using generated token');
      challengeToken = generateSessionToken('St.ott-v2');
    }
  } catch (err) {
    log.warn('[email-step] /util/gc call failed, using generated token:', err.message);
    challengeToken = generateSessionToken('St.ott-v2');
  }
  
  // Fallback to random cres if not computed from mdata
  if (!cres) {
    cres = generateChallengeToken({ type: 'cres' });
  }
  
  try {
    // Build request payload matching real Chrome DevTools capture
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
    
    // Log full response for debugging 400 errors
    if (response.status === 400) {
      log.warn(`[email-step] 400 Response: ${JSON.stringify(response.data)}`);
    }
    
    // Extract token for password step from response
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
      
      // Return the error response for analysis
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
  
  log.debug('Submitting password');
  touchSession(session);
  
  // Get token and correlation ID from email step
  const { correlationId, token, startTime } = emailStepResult;
  
  // Add human delay before submission (simulating typing password)
  await humanDelay(1000, 2000);
  
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
    
    log.debug(`[password-step] /util/gc response: ${gcResponse.status}`);
    
    if (gcResponse.status === 200 && gcResponse.data?.token) {
      challengeToken = gcResponse.data.token;
      log.debug(`[password-step] Got challenge token from /util/gc: ${challengeToken.substring(0, 50)}...`);
      
      // Compute cres from mdata
      if (gcResponse.data?.mdata) {
        cres = generateChallengeToken({ type: 'cres', mdata: gcResponse.data.mdata });
        log.debug(`[password-step] Computed cres from mdata: ${cres}`);
      }
    } else {
      log.warn('[password-step] /util/gc did not return a token, using generated token');
      challengeToken = generateSessionToken('St.ott-v2');
    }
  } catch (err) {
    log.warn('[password-step] /util/gc call failed, using generated token:', err.message);
    challengeToken = generateSessionToken('St.ott-v2');
  }
  
  // Fallback to random cres if not computed from mdata
  if (!cres) {
    cres = generateChallengeToken({ type: 'cres' });
  }
  
  try {
    // Build request payload matching real Chrome DevTools capture
    const payload = {
      user_key: password,
      token: token, // Token from email step response
      trust_device: true,
      revoke_token: null,
      challenge: {
        cres: cres,
        token: challengeToken,
      },
    };
    
    log.debug(`[password-step] cres=${cres} has_token=${!!token}`);
    
    const url = `${LOGIN_BASE}${LOGIN_COMPLETE_PATH}`;
    
    const response = await client.post(url, payload, {
      timeout: timeoutMs,
      maxRedirects: 0, // Don't follow redirects automatically
      validateStatus: (status) => status < 600, // Accept all statuses
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
