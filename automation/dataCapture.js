const TARGET_ACCOUNT_URL = 'https://my.rakuten.co.jp/?l-id=pc_header_memberinfo_popup_account';
const TARGET_HOME_URL = 'https://www.rakuten.co.jp/';
const HEADER_INFO_URL = 'https://ichiba-common-web-gateway.rakuten.co.jp/ichiba-common/headerinfo/get/v1';
const { createLogger } = require('../logger');

const log = createLogger('capture');

function sleep(page, ms) {
  if (page && typeof page.waitForTimeout === 'function') {
    return page.waitForTimeout(ms);
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForXPathText(page, xpath, timeoutMs) {
  log.debug(`waiting for xpath: ${xpath}`);
  try {
    const textHandle = await page.waitForFunction(
      (xp) => {
        const result = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const node = result.singleNodeValue;
        if (!node) return null;
        const txt = (node.textContent || '').trim();
        return txt || null;
      },
      { timeout: timeoutMs },
      xpath,
    );

    const text = await textHandle.jsonValue();
    if (!text) {
      throw new Error(`Element text empty for xpath: ${xpath}`);
    }
    return text;
  } catch (err) {
    throw new Error(`Failed to read xpath ${xpath}: ${err.message}`);
  }
}

async function captureAccountData(session, options = {}) {
  if (!session || !session.page) {
    throw new Error('No active browser session for data capture');
  }
  const { page } = session;
  const { timeoutMs = 30000 } = options;

  log.info('navigating to rakuten home');
  await page.goto(TARGET_HOME_URL, {
    waitUntil: 'networkidle0',
    timeout: timeoutMs,
  });

  // Extract points from the home page header
  log.debug('extracting points from home page header');
  let pointsText = 'n/a';
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts && pointsText === 'n/a') {
    attempts += 1;
    try {
      log.debug(`points extraction attempt ${attempts}/${maxAttempts}`);
      
      // Wait for the points element to be available
      await page.waitForSelector('a[href*="point.rakuten"]', { timeout: 5000 });
      
      // Wait a bit more for content to render
      await sleep(page, 500);
      
      // Extract the numeric part
      const result = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="point.rakuten"]');
        if (links.length === 0) {
          return { error: 'no_links', count: 0 };
        }
        
        const text = links[0].innerText.trim();
        if (!text) {
          return { error: 'empty_text', count: links.length };
        }
        
        const match = text.match(/[0-9,]+/);
        if (!match) {
          return { error: 'no_match', text: text };
        }
        
        return { success: true, points: match[0] };
      });

      log.debug(`extraction result:`, JSON.stringify(result));

      if (result.success) {
        pointsText = result.points;
        log.info(`points extracted (attempt ${attempts}): ${pointsText}`);
      } else {
        log.warn(`extraction failed: ${result.error}`, result);
        if (attempts < maxAttempts) {
          await sleep(page, 1000); // wait before retry
        }
      }
    } catch (err) {
      log.warn(`points extraction error (attempt ${attempts}): ${err.message}`);
      if (attempts < maxAttempts) {
        await sleep(page, 1000);
      }
    }
  }

  log.info(`captured points: ${pointsText}`);

  return {
    points: pointsText,
    cash: 'n/a',
    rank: 'n/a',
    url: page.url(),
  };
}
module.exports = {
  captureAccountData,
};
