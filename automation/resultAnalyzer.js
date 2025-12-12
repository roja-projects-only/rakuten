const fs = require('fs').promises;
const path = require('path');
const { createLogger } = require('../logger');

const log = createLogger('analyzer');

async function detectOutcome(page, response) {
  try {
    log.debug('[detect] start', response?.status, response?.url);
    const currentUrl = page.url();
    const pageContent = await page.content().catch(() => '');
    log.debug('[detect] url', currentUrl);

    if (response) {
      if (response.status === 200) {
        if (typeof page.waitForTimeout === 'function') {
          await page.waitForTimeout(2000);
        } else {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        const finalUrl = page.url();
        log.debug('[detect] 200 finalUrl', finalUrl);
        if (finalUrl.includes('www.rakuten.co.jp') && finalUrl.includes('code=')) {
          return {
            status: 'VALID',
            message: 'Login successful - Valid credentials',
            url: finalUrl,
          };
        }
      }

      if (response.status === 401) {
        const errorMessage = response.body?.message || 'Invalid Authorization';
        const errorCode = response.body?.errorCode || 'UNKNOWN';
        log.debug('[detect] 401', errorCode, errorMessage);
        return {
          status: 'INVALID',
          message: `Invalid credentials - ${errorCode}: ${errorMessage}`,
        };
      }
    }

    const contentLower = pageContent.toLowerCase();
    const blockedIndicators = ['captcha', 'recaptcha', 'challenge', 'verify you are human', 'unusual activity'];

    const blockedMatch = blockedIndicators.find((indicator) => contentLower.includes(indicator));
    if (blockedMatch) {
      return {
        status: 'BLOCKED',
        message: `Account blocked or verification required - Detected: ${blockedMatch}`,
      };
    }

    const invalidIndicators = ['incorrect', 'invalid', 'wrong password', 'wrong email', 'authentication failed'];
    const invalidMatch = invalidIndicators.find((indicator) => contentLower.includes(indicator));
    if (invalidMatch) {
      return {
        status: 'INVALID',
        message: `Invalid credentials - Found error: ${invalidMatch}`,
      };
    }

    if (currentUrl.includes('www.rakuten.co.jp') && currentUrl.includes('code=')) {
      log.debug('[detect] URL-based valid');
      return {
        status: 'VALID',
        message: 'Login successful - Redirected to main site',
        url: currentUrl,
      };
    }

    log.debug('[detect] fallback ERROR');
    return {
      status: 'ERROR',
      message: 'Unable to determine login status - Please check manually',
      url: currentUrl,
    };
  } catch (error) {
    log.warn('[detect] exception', error.message);
    return {
      status: 'ERROR',
      message: `Detection error: ${error.message}`,
    };
  }
}

async function captureScreenshot(page, status) {
  try {
    const screenshotDir = path.join(process.cwd(), 'screenshots');
    await fs.mkdir(screenshotDir, { recursive: true });

    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+/, '')
      .replace('T', '-');
    const filename = `${status}-${timestamp}.png`;
    const filepath = path.join(screenshotDir, filename);

    await page.screenshot({ path: filepath, fullPage: true });
    return filepath;
  } catch (error) {
    log.warn('Failed to capture screenshot:', error.message);
    return null;
  }
}

module.exports = {
  detectOutcome,
  captureScreenshot,
};
