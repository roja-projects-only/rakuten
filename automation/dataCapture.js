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
    waitUntil: 'networkidle2',
    timeout: timeoutMs,
  });

  // Wait for page to fully render
  await sleep(page, 1000);

  // Extract points from the home page header
  log.debug('extracting points from home page header');
  let pointsText = 'n/a';
  let attempts = 0;
  const maxAttempts = 2;

  while (attempts < maxAttempts && pointsText === 'n/a') {
    attempts += 1;
    try {
      log.debug(`points extraction attempt ${attempts}/${maxAttempts}`);
      
      const result = await page.evaluate(() => {
        // Strategy 1: Look for links with "保有ポイント" text specifically
        const allLinks = document.querySelectorAll('a');
        
        for (let link of allLinks) {
          const text = (link.innerText || link.textContent || '').trim();
          if (text.includes('保有ポイント')) {
            const match = text.match(/(\d{1,3}(?:,\d{3})*)/);
            if (match) {
              return { success: true, points: match[1], via: 'holding_points_link' };
            }
          }
        }

        // Fallback: look for any link with point.rakuten in href
        const pointLinks = document.querySelectorAll('a[href*="point.rakuten"]');
        for (let link of pointLinks) {
          const text = (link.innerText || link.textContent || '').trim();
          const match = text.match(/(\d{1,3}(?:,\d{3})*)/);
          if (match) {
            const numericValue = parseInt(match[1].replace(/,/g, ''), 10);
            if (numericValue > 100) {
              return { success: true, points: match[1], via: 'point_rakuten_href', numericValue };
            }
          }
        }

        // Last resort: search for largest number with comma format
        let largestPoints = null;
        let largestValue = 0;
        
        for (let link of allLinks) {
          const text = (link.innerText || link.textContent || '').trim();
          const matches = text.match(/(\d{1,3}(?:,\d{3})+)/g);
          
          if (matches) {
            for (let match of matches) {
              const numericValue = parseInt(match.replace(/,/g, ''), 10);
              if (numericValue > largestValue && numericValue < 999999) {
                largestValue = numericValue;
                largestPoints = match;
              }
            }
          }
        }
        
        if (largestPoints && largestValue > 100) {
          return { success: true, points: largestPoints, via: 'largest_comma_number', numericValue: largestValue };
        }

        return { error: 'no_points_found' };
      });

      if (result.success) {
        pointsText = result.points;
        log.info(`points extracted (attempt ${attempts}): ${pointsText} [${result.via}]`);
      } else {
        log.warn(`extraction failed on attempt ${attempts}, retrying...`);
        if (attempts < maxAttempts) {
          await sleep(page, 800);
        }
      }
    } catch (err) {
      log.warn(`points extraction error (attempt ${attempts}): ${err.message}`);
      if (attempts < maxAttempts) {
        await sleep(page, 800);
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
