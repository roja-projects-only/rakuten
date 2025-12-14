const TARGET_ACCOUNT_URL = 'https://my.rakuten.co.jp/?l-id=pc_header_memberinfo_popup_account';
const TARGET_HOME_URL = 'https://www.rakuten.co.jp/';
const HEADER_INFO_URL = 'https://ichiba-common-web-gateway.rakuten.co.jp/ichiba-common/headerinfo/get/v1';

// Membership rank translations
const MEMBERSHIP_TRANSLATIONS = {
  'プラチナ会員': 'Platinum',
  'ゴールド会員': 'Gold',
  'シルバー会員': 'Silver',
  'ブロンズ会員': 'Bronze',
  '通常会員': 'Regular',
};

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
  log.debug('extracting points and membership from home page');
  let pointsText = 'n/a';
  let membershipText = 'n/a';
  let attempts = 0;
  const maxAttempts = 2;

  while (attempts < maxAttempts && pointsText === 'n/a') {
    attempts += 1;
    try {
      log.debug(`extraction attempt ${attempts}/${maxAttempts}`);
      
      const result = await page.evaluate(() => {
        const extraction = { points: null, membership: null };

        // Extract membership status from em tags (primary location)
        const emElements = document.querySelectorAll('em');
        for (let em of emElements) {
          const text = (em.innerText || em.textContent || '').trim();
          if (text.match(/^(プラチナ|ゴールド|シルバー|ブロンズ|通常)会員$/)) {
            extraction.membership = text;
            log.info(`Found membership in em tag: ${text}`);
            break;
          }
        }

        // If not found in em, try looking in all elements more broadly
        if (!extraction.membership) {
          const allElements = document.querySelectorAll('*');
          for (let el of allElements) {
            const text = (el.innerText || el.textContent || '').trim();
            if (text.match(/^(プラチナ|ゴールド|シルバー|ブロンズ|通常)会員$/) && text.length < 20) {
              extraction.membership = text;
              break;
            }
          }
        }

        // Extract points
        const allLinks = document.querySelectorAll('a');
        
        for (let link of allLinks) {
          const text = (link.innerText || link.textContent || '').trim();
          if (text.includes('保有ポイント')) {
            const match = text.match(/(\d{1,3}(?:,\d{3})*)/);
            if (match) {
              extraction.points = match[1];
              return extraction;
            }
          }
        }

        // Fallback for points
        const pointLinks = document.querySelectorAll('a[href*="point.rakuten"]');
        for (let link of pointLinks) {
          const text = (link.innerText || link.textContent || '').trim();
          const match = text.match(/(\d{1,3}(?:,\d{3})*)/);
          if (match) {
            const numericValue = parseInt(match[1].replace(/,/g, ''), 10);
            if (numericValue > 100) {
              extraction.points = match[1];
              return extraction;
            }
          }
        }

        // Last resort for points
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
          extraction.points = largestPoints;
        }

        return extraction;
      });

      if (result.points) {
        pointsText = result.points;
        log.info(`points extracted (attempt ${attempts}): ${pointsText}`);
      }
      
      if (result.membership) {
        membershipText = result.membership;
        log.info(`membership extracted: ${membershipText}`);
      }

      if (result.points) {
        break; // Success, exit loop
      } else {
        log.warn(`extraction failed on attempt ${attempts}, retrying...`);
        if (attempts < maxAttempts) {
          await sleep(page, 800);
        }
      }
    } catch (err) {
      log.warn(`extraction error (attempt ${attempts}): ${err.message}`);
      if (attempts < maxAttempts) {
        await sleep(page, 800);
      }
    }
  }

  // If membership still not found, try navigating to points page
  if (membershipText === 'n/a') {
    try {
      log.info('membership not found on home page, checking points page');
      await page.goto('https://point.rakuten.co.jp/', {
        waitUntil: 'networkidle2',
        timeout: timeoutMs,
      });
      await sleep(page, 500);

      const pointsPageMembership = await page.evaluate(() => {
        const emElements = document.querySelectorAll('em');
        for (let em of emElements) {
          const text = (em.innerText || em.textContent || '').trim();
          if (text.match(/^(プラチナ|ゴールド|シルバー|ブロンズ|通常)会員$/)) {
            return text;
          }
        }
        return null;
      });

      if (pointsPageMembership) {
        membershipText = pointsPageMembership;
        log.info(`membership found on points page: ${membershipText}`);
      }
    } catch (err) {
      log.warn(`failed to get membership from points page: ${err.message}`);
    }
  }

  // Translate membership status
  const membershipEnglish = MEMBERSHIP_TRANSLATIONS[membershipText] || membershipText;

  log.info(`captured points: ${pointsText}, membership: ${membershipEnglish}`);

  return {
    points: pointsText,
    cash: 'n/a',
    rank: membershipEnglish,
    url: page.url(),
  };
}
module.exports = {
  captureAccountData,
};
