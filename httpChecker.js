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
const { createLogger } = require('./logger');

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
  
  const { client } = session;
  
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
 * Drop-in replacement for puppeteerChecker.checkCredentials()
 * 
 * @param {string} email - Email/username
 * @param {string} password - Password
 * @param {Object} [options] - Check options
 * @param {string} [options.targetUrl] - Target login URL
 * @param {number} [options.timeoutMs=60000] - Timeout in milliseconds
 * @param {string} [options.proxy] - Proxy URL
 * @param {boolean} [options.screenshotOn=false] - Screenshot (not applicable for HTTP)
 * @param {boolean} [options.headless] - Headless mode (not applicable for HTTP)
 * @param {Function} [options.onProgress] - Progress callback
 * @param {boolean} [options.deferCloseOnValid=false] - Keep session open if valid
 * @returns {Promise<Object>} Result object with status, message, session
 */
async function checkCredentials(email, password, options = {}) {
  const {
    targetUrl = process.env.TARGET_LOGIN_URL,
    timeoutMs = 60000,
    proxy = null,
    screenshotOn = false,
    headless = true,
    onProgress = null,
    deferCloseOnValid = false,
  } = options;

  if (!targetUrl) {
    throw new Error('Target login URL is required');
  }

  let session = null;
  let preserveSession = false;

  try {
    log.debug('Starting credential check');
    onProgress && (await onProgress('launch'));
    
    // Create HTTP session
    session = createSession({
      proxy,
      timeout: timeoutMs,
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

    // Note: Screenshots not applicable for HTTP checker
    if (screenshotOn) {
      log.debug('Screenshot option ignored (not applicable for HTTP checker)');
    }

    preserveSession = deferCloseOnValid && outcome.status === 'VALID';
    
    return {
      ...outcome,
      session: preserveSession ? session : undefined,
    };
  } catch (error) {
    log.error('Error during credential check:', error.message);

    return {
      status: 'ERROR',
      message: `HTTP automation error: ${error.message}`,
      screenshot: null,
    };
  } finally {
    if (!preserveSession && session) {
      closeSession(session);
    }
  }
}

module.exports = { checkCredentials };
