const EMAIL_SELECTOR = 'input[type="email"], input[name*="user" i], input[name*="email" i], input[aria-label*="username" i], input[aria-label*="email" i]';
const PASSWORD_SELECTOR = 'input[type="password"], input[name*="password" i], input[aria-label*="password" i]';

const ADVANCE_BUTTON_SELECTORS = [
  'button[type="submit"], input[type="submit"]',
  'button[name*="next" i]',
  '#cta011', // explicit Rakuten CTA
];

const ADVANCE_TEXT_MATCHES = ['next', 'sign in', 'log in', '次へ', '次に進む', 'ログイン'];
const CLICK_INTERVAL_MS = 300;

const { createLogger } = require('../logger');
const log = createLogger('flow');

async function queryXPath(page, xpath) {
  try {
    return await page.evaluateHandle((xp) => {
      const doc = document;
      const iterator = doc.evaluate(xp, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const nodes = [];
      for (let i = 0; i < iterator.snapshotLength; i++) {
        nodes.push(iterator.snapshotItem(i));
      }
      return nodes[0] || null;
    }, xpath);
  } catch (err) {
    log.warn(`XPath eval failed (${xpath}):`, err.message);
    return null;
  }
}

function sleep(page, ms) {
  if (typeof page.waitForTimeout === 'function') {
    return page.waitForTimeout(ms);
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function navigateToLogin(page, targetUrl, timeoutMs) {
  await page.goto(targetUrl, {
    waitUntil: 'networkidle0',
    timeout: timeoutMs,
  });
}

async function submitEmailStep(page, email, timeoutMs) {
  await page.waitForSelector(EMAIL_SELECTOR, { timeout: timeoutMs });
  await clearAndType(page, EMAIL_SELECTOR, email);
  await sleep(page, 1000); // allow UI/state to stabilize before advancing
  await clickAdvanceButton(page, timeoutMs);
  await waitForPasswordScreen(page, timeoutMs);
}

async function submitPasswordStep(page, password, timeoutMs) {
  await page.waitForSelector(PASSWORD_SELECTOR, { timeout: timeoutMs });
  await clearAndType(page, PASSWORD_SELECTOR, password);
  await sleep(page, 1000); // small buffer to avoid premature submit on slow UIs

  // Blur the password field before clicking next to avoid focused-field intercepts.
  try {
    await page.evaluate(() => {
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
    });
    await sleep(page, 150);
  } catch (err) {
    log.warn('Unable to blur active element:', err.message);
  }

  let capturedResponse = null;
  const listener = async (resp) => {
    try {
      if (resp.url().includes('/v2/login/complete') && !capturedResponse) {
        capturedResponse = await normalizeResponse(resp);
        log.debug('[flow] response listener captured /v2/login/complete', capturedResponse?.status);
      }
    } catch (err) {
      log.warn('Response listener parse failed:', err.message);
    }
  };
  page.on('response', listener);

  const loginResponsePromise = page
    .waitForResponse((response) => response.url().includes('/v2/login/complete'), { timeout: timeoutMs })
    .then(async (resp) => {
      const norm = await normalizeResponse(resp);
      log.debug('[flow] waitForResponse resolved /v2/login/complete', norm?.status);
      return norm;
    })
    .catch(() => null);

  await clickAdvanceButton(page, timeoutMs);
  const waited = await loginResponsePromise;
  log.debug('[flow] waited response', waited?.status);
  const loginResponse = waited || capturedResponse;
  page.off('response', listener);
  await sleep(page, 2000);
  return loginResponse;
}

async function normalizeResponse(response) {
  if (!response) {
    return null;
  }

  const payload = {
    status: response.status(),
    statusText: response.statusText(),
    url: response.url(),
  };

  try {
    const contentType = response.headers()['content-type'] || response.headers()['Content-Type'];
    if (contentType && contentType.includes('application/json')) {
      payload.body = await response.json();
    }
  } catch (err) {
    log.warn('Unable to parse login response body:', err.message);
  }

  return payload;
}

async function waitForPasswordScreen(page, timeoutMs) {
  await Promise.race([
    page.waitForSelector(PASSWORD_SELECTOR, { timeout: timeoutMs }),
    page.waitForFunction(
      () => typeof window !== 'undefined' && window.location.hash.includes('password'),
      { timeout: timeoutMs }
    ),
  ]);
}

async function clearAndType(page, selector, value) {
  const element = await page.$(selector);
  if (!element) {
    throw new Error(`Input not found for selector: ${selector}`);
  }

  await element.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(selector, value, { delay: 50 });
}

async function clickAdvanceButton(page, timeoutMs) {
  // Try CSS selectors first (including explicit Rakuten CTA id).
  for (const selector of ADVANCE_BUTTON_SELECTORS) {
    const button = await page.$(selector);
    if (button) {
      try {
        await button.evaluate((el) => el.click());
        await sleep(page, CLICK_INTERVAL_MS);
        await sleep(page, 300); // let UI settle before next actions
        return;
      } catch (err) {
        log.warn(`Advance click via selector failed (${selector}):`, err.message);
      }
    }
  }

  // Try XPath fallback (e.g., provided CTA xpath).
  const xpaths = ['//*[@id="cta011"]'];
  for (const xpath of xpaths) {
    const handle = await queryXPath(page, xpath);
    const target = handle && handle.asElement && handle.asElement();
    if (target) {
      try {
        await target.evaluate((el) => el.click());
        await sleep(page, CLICK_INTERVAL_MS);
        await sleep(page, 300);
        return;
      } catch (err) {
        log.warn(`Advance click via XPath failed (${xpath}):`, err.message);
      }
    }
  }

  const buttonHandle = await page.evaluateHandle((labels) => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
    return (
      candidates.find((btn) => {
        const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        return labels.some((label) => text.includes(label));
      }) || null
    );
  }, ADVANCE_TEXT_MATCHES);

  const element = buttonHandle && buttonHandle.asElement();
  if (!element) {
    throw new Error('Unable to find navigation button on the page');
  }

  try {
    await element.evaluate((el) => el.click());
    await sleep(page, CLICK_INTERVAL_MS);
    await sleep(page, 300);
    return;
  } catch (err) {
    log.warn('Advance click via text match failed:', err.message);
  }

  // Fallback: press Enter to submit the active form.
  await page.keyboard.press('Enter');
  await sleep(page, 300);
}

module.exports = {
  navigateToLogin,
  submitEmailStep,
  submitPasswordStep,
};
