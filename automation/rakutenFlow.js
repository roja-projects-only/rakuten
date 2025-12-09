const EMAIL_SELECTOR = 'input[type="email"], input[name*="user" i], input[name*="email" i], input[aria-label*="username" i], input[aria-label*="email" i]';
const PASSWORD_SELECTOR = 'input[type="password"], input[name*="password" i], input[aria-label*="password" i]';

const ADVANCE_BUTTON_SELECTORS = [
  'button[type="submit"], input[type="submit"]',
  'button[name*="next" i]'
];

const ADVANCE_TEXT_MATCHES = ['next', 'sign in', 'log in', '次へ', '次に進む', 'ログイン'];

async function navigateToLogin(page, targetUrl, timeoutMs) {
  await page.goto(targetUrl, {
    waitUntil: 'networkidle0',
    timeout: timeoutMs,
  });
}

async function submitEmailStep(page, email, timeoutMs) {
  await page.waitForSelector(EMAIL_SELECTOR, { timeout: timeoutMs });
  await clearAndType(page, EMAIL_SELECTOR, email);
  await clickAdvanceButton(page, timeoutMs);
  await waitForPasswordScreen(page, timeoutMs);
}

async function submitPasswordStep(page, password, timeoutMs) {
  await page.waitForSelector(PASSWORD_SELECTOR, { timeout: timeoutMs });
  await clearAndType(page, PASSWORD_SELECTOR, password);

  const loginResponsePromise = page
    .waitForResponse(
      (response) => response.url().includes('/v2/login/complete'),
      { timeout: timeoutMs }
    )
    .then(async (response) => {
      if (!response) {
        return null;
      }

      const payload = {
        status: response.status(),
        statusText: response.statusText(),
        url: response.url(),
      };

      try {
        const contentType = response.headers()['content-type'];
        if (contentType && contentType.includes('application/json')) {
          payload.body = await response.json();
        }
      } catch (err) {
        console.warn('Unable to parse login response body:', err.message);
      }

      return payload;
    })
    .catch(() => null);

  await clickAdvanceButton(page, timeoutMs);
  const loginResponse = await loginResponsePromise;
  await page.waitForTimeout(2000);
  return loginResponse;
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
  for (const selector of ADVANCE_BUTTON_SELECTORS) {
    const button = await page.$(selector);
    if (button) {
      await button.click();
      return;
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

  await element.click();
}

module.exports = {
  navigateToLogin,
  submitEmailStep,
  submitPasswordStep,
};
