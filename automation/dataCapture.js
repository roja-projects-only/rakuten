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

  // Wait briefly to ensure session cookies are settled, then try API-first for accuracy.
  await sleep(page, 500).catch(() => {});
  const apiResult = await fetchHeaderInfo(page, timeoutMs).catch((err) => {
    log.warn(`headerinfo fetch failed: ${err.message}`);
    return null;
  });

  if (apiResult && (apiResult.totalPoint != null || apiResult.rcashPoint != null)) {
    // Translate rank to English if present
    const rankEn = translateRank(apiResult.rank);
    return {
      points: apiResult.totalPoint != null ? String(apiResult.totalPoint) : 'n/a',
      cash: apiResult.rcashPoint != null ? String(apiResult.rcashPoint) : 'n/a',
      rank: rankEn,
      url: page.url(),
    };
  }

  // Fallback to account page DOM scrape if API is unavailable.
  log.info('headerinfo unavailable, falling back to account page scrape');
  await page.goto(TARGET_ACCOUNT_URL, {
    waitUntil: 'networkidle0',
    timeout: timeoutMs,
  });

  // Extract points using accurate XPath
  const pointsXPath = '//*[@id="wrapper"]/div[8]/div/ul[1]/li[3]//div[@class="value--21p0x"][1]';
  const pointsText = await waitForXPathText(page, pointsXPath, timeoutMs);
  log.debug(`points extracted: ${pointsText}`);

  // Try to hover over the button to reveal cash/rank data
  let cashText = 'n/a';
  let rankText = 'n/a';
  try {
    const hoverButtonXPath = '//*[@id="wrapper"]/div[8]/div/ul[2]/li/div/div[1]/button';
    const hoverResult = await page.waitForXPath(hoverButtonXPath, { timeout: 5000 }).catch(() => null);
    
    if (hoverResult) {
      log.debug('Found hover button, triggering hover...');
      await page.evaluate((xpath) => {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const btn = result.singleNodeValue;
        if (btn) {
          btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
        }
      }, hoverButtonXPath);
      
      await sleep(page, 300); // Wait for hover effect to render
      
      // Try to extract cash data
      const cashXPath = '//*[@id="wrapper"]/div[8]/div/ul[2]/li/div/div[3]/div/div/div/div[3]/div[2]/a/div/div[1]/div';
      cashText = await waitForXPathText(page, cashXPath, 3000).catch(() => 'n/a');
      log.debug(`cash extracted: ${cashText}`);
      
      // Try to extract membership rank
      const rankXPath = '//*[@id="wrapper"]/div[8]/div/ul[2]/li/div/div[3]/div/div/div/div[1]/div[2]/div[2]/font/font';
      rankText = await waitForXPathText(page, rankXPath, 3000).catch(() => 'n/a');
      log.debug(`rank extracted: ${rankText}`);
    } else {
      log.warn('Hover button not found, skipping cash/rank extraction');
    }
  } catch (err) {
    log.warn(`Failed to extract cash/rank via hover: ${err.message}`);
  }

  log.info(`points: ${pointsText} | cash: ${cashText} | rank: ${rankText}`);

  return {
    points: pointsText,
    cash: cashText,
    rank: rankText !== 'n/a' ? translateRank(rankText) : 'n/a',
    url: page.url(),
  };
}

/**
 * Translate Japanese membership rank names to English.
 * @param {string} rank - Japanese rank name (e.g., 'ゴールド')
 * @returns {string} English rank name or original if not found
 */
function translateRank(rank) {
  if (!rank) return 'n/a';
  
  const rankMap = {
    'ダイヤモンド': 'Diamond',
    'プラチナ': 'Platinum',
    'ゴールド': 'Gold',
    'シルバー': 'Silver',
    '通常': 'Regular',
    '楽天会員': 'Rakuten Member',
  };
  
  return rankMap[rank] || rank;
}

async function fetchHeaderInfo(page, timeoutMs) {
  return page.evaluate(
    async ({ url, timeoutMs: t }) => {
      const attemptFetch = async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), t);
        try {
          const res = await fetch(url, { credentials: 'include', signal: controller.signal });
          if (!res.ok) throw new Error(`status ${res.status}`);
          const json = await res.json();
          const pointInfo = json?.body?.memberPointInfo?.data?.pointInfo;
          if (!pointInfo) throw new Error('missing pointInfo');
          return {
            totalPoint: json?.body?.memberPointInfo?.data?.pointInvestInfo?.totalPoint ?? pointInfo.fixedStdPoint ?? pointInfo.unfixedStdPoint,
            rcashPoint: pointInfo.rcashPoint,
            rank: json?.body?.memberRankInfo?.data?.rankInfo?.rankId,
          };
        } finally {
          clearTimeout(timer);
        }
      };

      // Try up to 2 attempts in case the endpoint isn't ready immediately.
      try {
        return await attemptFetch();
      } catch (err) {
        await new Promise((r) => setTimeout(r, 500));
        return await attemptFetch();
      }
    },
    { url: HEADER_INFO_URL, timeoutMs }
  );
}

module.exports = {
  captureAccountData,
};
