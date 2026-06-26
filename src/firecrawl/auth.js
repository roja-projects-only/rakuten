// LOCAL-ONLY: not for production services.
// @ts-check

'use strict';

const fs = require('fs');
const path = require('path');
const { checkCredentials } = require('../shared/http/checker');
const { closeSession } = require('../shared/http/sessionManager');
const { config } = require('./config');
const { createLogger } = require('../shared/logger');

const log = createLogger('firecrawl:auth');

/**
 * Logs into Rakuten using HTTP-based credential checking.
 *
 * Replaces the old Firecrawl browser-interact login flow with a lightweight
 * HTTP request flow that reuses the production checker module.
 *
 * @param {{ email: string, password: string }} credentials - Account credentials.
 * @param {Object} [options] - Login options.
 * @param {string} [options.targetUrl] - Target login URL (defaults to TARGET_LOGIN_URL env).
 * @param {number} [options.timeoutMs=60000] - Timeout in milliseconds for each request.
 * @param {string|null} [options.proxy=null] - Proxy URL to route requests through.
 * @returns {Promise<{ success: boolean, session?: Object, status: string, message?: string, error?: string }>}
 */
async function loginViaHttp(credentials, options = {}) {
  const { email, password } = credentials;
  const {
    targetUrl = process.env.TARGET_LOGIN_URL,
    timeoutMs = 60000,
    proxy = null,
  } = options;

  // Enable local (skip network-connectivity-test) PoW mode idempotently
  if (!process.env.POW_SKIP_CONNECTION_TEST) {
    process.env.POW_SKIP_CONNECTION_TEST = '1';
    log.debug('Local PoW mode enabled (POW_SKIP_CONNECTION_TEST=1)');
  }

  // Validate inputs
  if (!email || !password) {
    throw new Error('email and password are required');
  }

  if (!targetUrl) {
    throw new Error('targetUrl is required (set TARGET_LOGIN_URL)');
  }

  log.info('Starting HTTP login via checkCredentials...');

  try {
    const result = await checkCredentials(email, password, {
      deferCloseOnValid: true,
      targetUrl,
      timeoutMs,
      proxy,
    });

    if (result.status === 'VALID' && result.session) {
      log.info('HTTP login successful (VALID)');
      return { success: true, session: result.session, status: 'VALID' };
    }

    // Defensively close the session if one was created but login failed
    if (result.session) {
      closeSession(result.session);
    }

    log.error(`HTTP login failed: status=${result.status}${result.message ? ', message=' + result.message : ''}`);
    return {
      success: false,
      status: result.status,
      message: result.message,
      error: `Login status: ${result.status}`,
    };
  } catch (err) {
    log.error('HTTP login threw');
    log.debug(`Error details: ${err.message}`);
    return { success: false, status: 'ERROR', message: err.message, error: err.message };
  }
}

/**
 * Closes an HTTP session safely.
 *
 * Thin wrapper around sessionManager.closeSession so callers do not need to
 * import sessionManager directly.
 *
 * @param {Object|null|undefined} session - The HTTP session to close.
 */
function closeHttpSession(session) {
  if (!session) return;

  try {
    closeSession(session);
  } catch (err) {
    log.warn(`Failed to close HTTP session: ${err.message}`);
  }
}

/**
 * Writes a lightweight login result log to data/firecrawl/login-{timestamp}.json.
 *
 * No credentials or secrets are included in the output.
 *
 * @param {{ success: boolean, status: string, message?: string }} result - Login result to persist.
 * @returns {string} The file path written to.
 */
function writeLoginOutput(result) {
  const ts = new Date();
  const fileSafeTs = ts.toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve(__dirname, '..', '..', 'data', 'firecrawl');

  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `login-${fileSafeTs}.json`);

  /** @type {Object} */
  const output = {
    metadata: {
      timestamp: ts.toISOString(),
      configHash: config.hash,
      script: 'login-http',
    },
    status: result.status,
    success: result.success,
  };

  if (result.message) {
    output.message = result.message;
  }

  fs.writeFileSync(filePath, JSON.stringify(output, null, 2), 'utf-8');
  log.info(`Login output saved to ${filePath}`);

  return filePath;
}

module.exports = { loginViaHttp, closeHttpSession, writeLoginOutput };
