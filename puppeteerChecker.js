/**
 * =============================================================================
 * RAKUTEN LOGIN FLOW - PUPPETEER AUTOMATION ENGINE
 * =============================================================================
 * This module now orchestrates the Rakuten credential check by delegating
 * browser/session management, navigation steps, and outcome analysis to
 * smaller focused helpers located in ./automation/*.
 * =============================================================================
 */

const { createBrowserSession, closeBrowserSession } = require('./automation/browserManager');
const { navigateToLogin, submitEmailStep, submitPasswordStep } = require('./automation/rakutenFlow');
const { detectOutcome, captureScreenshot } = require('./automation/resultAnalyzer');

async function checkCredentials(email, password, options = {}) {
  const {
    targetUrl = process.env.TARGET_LOGIN_URL,
    timeoutMs = 60000,
    proxy = null,
    screenshotOn = false,
    headless = process.env.HEADLESS,
    onProgress = null,
    deferCloseOnValid = false,
  } = options;

  if (!targetUrl) {
    throw new Error('Target login URL is required');
  }

  let session = null;
  let page = null;
  let screenshotPath = null;
  let preserveSession = false;

  try {
    console.log('🌐 Launching headless browser...');
    onProgress && (await onProgress('launch'));
    session = await createBrowserSession({ proxy, headless });
    page = session.page;

    console.log('📍 Navigating to Rakuten login page...');
    onProgress && (await onProgress('navigate'));
    await navigateToLogin(page, targetUrl, timeoutMs);

    console.log('📧 Submitting email/username step...');
    onProgress && (await onProgress('email'));
    await submitEmailStep(page, email, timeoutMs);

    console.log('🔑 Submitting password step...');
    onProgress && (await onProgress('password'));
    const loginResponse = await submitPasswordStep(page, password, timeoutMs);

    console.log('🔍 Analyzing login result...');
    onProgress && (await onProgress('analyze'));
    const outcome = await detectOutcome(page, loginResponse);

    if (screenshotOn) {
      screenshotPath = await captureScreenshot(page, outcome.status);
      if (screenshotPath) {
        outcome.screenshot = screenshotPath;
      }
    }

    preserveSession = deferCloseOnValid && outcome.status === 'VALID';
    return {
      ...outcome,
      session: preserveSession ? session : undefined,
    };
  } catch (error) {
    console.error('❌ Error during credential check:', error.message);

    if (page && screenshotOn) {
      try {
        screenshotPath = await captureScreenshot(page, 'ERROR');
      } catch (captureErr) {
        console.warn('Unable to capture error screenshot:', captureErr.message);
      }
    }

    return {
      status: 'ERROR',
      message: `Automation error: ${error.message}`,
      screenshot: screenshotPath,
    };
  } finally {
    if (!preserveSession) {
      await closeBrowserSession(session);
    }
  }
}

module.exports = { checkCredentials };
