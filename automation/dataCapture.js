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

  // Wait extra time for page to fully render (points element may be lazy-loaded)
  log.debug('waiting for page to fully stabilize');
  await sleep(page, 2000);

  // Extract points from the home page header
  log.debug('extracting points from home page header');
  let pointsText = 'n/a';
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts && pointsText === 'n/a') {
    attempts += 1;
    try {
      log.debug(`points extraction attempt ${attempts}/${maxAttempts}`);
      
      // First try: wait for selector with long timeout
      try {
        log.debug(`waiting for selector with 10s timeout`);
        await page.waitForSelector('a[href*="point.rakuten"]', { timeout: 10000 });
        log.debug(`selector found, waiting for render`);
        await sleep(page, 1000);
      } catch (selectorErr) {
        log.warn(`selector wait failed: ${selectorErr.message}, trying direct evaluation`);
        // Continue to evaluation attempt even if selector wait fails
      }
      
      // Extract via page.evaluate
      log.debug(`evaluating page to extract points`);
      const result = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="point.rakuten"]');
        if (links.length === 0) {
          // Try broader search
          const allLinks = document.querySelectorAll('a');
          let found = null;
          for (let link of allLinks) {
            if (link.href && link.href.includes('point.rakuten')) {
              found = link;
              break;
            }
          }
          if (!found) {
            return { error: 'no_links', linksSearched: allLinks.length };
          }
          links.push(found);
        }
        
        const text = links[0].innerText.trim();
        if (!text) {
          // Try textContent as fallback
          const textContent = (links[0].textContent || '').trim();
          if (!textContent) {
            return { error: 'empty_text', count: links.length };
          }
          const match = textContent.match(/[0-9,]+/);
          if (!match) {
            return { error: 'no_match_content', text: textContent.substring(0, 100) };
          }
          return { success: true, points: match[0], via: 'textContent' };
        }
        
        const match = text.match(/[0-9,]+/);
        if (!match) {
          return { error: 'no_match', text: text.substring(0, 100) };
        }
        
        return { success: true, points: match[0], via: 'innerText' };
      });

      log.debug(`extraction result:`, JSON.stringify(result));

      if (result.success) {
        pointsText = result.points;
        log.info(`points extracted (attempt ${attempts}): ${pointsText} [${result.via}]`);
      } else {
        log.warn(`extraction failed: ${result.error}`, result);
        if (attempts < maxAttempts) {
          log.debug(`waiting ${1500 + attempts * 500}ms before retry`);
          await sleep(page, 1500 + attempts * 500); // progressive backoff
        }
      }
    } catch (err) {
      log.warn(`points extraction error (attempt ${attempts}): ${err.message}`);
      log.trace(`error stack:`, err.stack);
      if (attempts < maxAttempts) {
        log.debug(`waiting ${1500 + attempts * 500}ms before retry`);
        await sleep(page, 1500 + attempts * 500);
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
