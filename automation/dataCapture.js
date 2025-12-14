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
    return {
      points: apiResult.totalPoint != null ? String(apiResult.totalPoint) : 'n/a',
      cash: apiResult.rcashPoint != null ? String(apiResult.rcashPoint) : 'n/a',
      rank: apiResult.rank,
      url: page.url(),
    };
  }

  // Fallback to account page DOM scrape if API is unavailable.
  log.info('headerinfo unavailable, falling back to account page scrape');
  await page.goto(TARGET_ACCOUNT_URL, {
    waitUntil: 'networkidle0',
    timeout: timeoutMs,
  });

  const pointsXPath = '/html/body/main/div[1]/div[1]/div[2]/div/div[2]/div[1]/a/span[1]/span[1]/span[2]';
  const cashXPath = '/html/body/main/div[1]/div[1]/div[2]/div/div[2]/div[1]/div[4]/span[2]';

  const pointsText = await waitForXPathText(page, pointsXPath, timeoutMs);
  const cashText = await waitForXPathText(page, cashXPath, timeoutMs);

  log.info(`points: ${pointsText} | cash: ${cashText}`);

  return {
    points: pointsText,
    cash: cashText,
    rank: apiResult && apiResult.rank,
    url: page.url(),
  };
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
