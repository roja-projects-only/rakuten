const TARGET_ACCOUNT_URL = 'https://my.rakuten.co.jp/?l-id=pc_header_memberinfo_popup_account';

async function waitForXPathText(page, xpath, timeoutMs) {
  console.log(`[capture] waiting for xpath: ${xpath}`);
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

  console.log('[capture] navigating to account page');
  await page.goto(TARGET_ACCOUNT_URL, {
    waitUntil: 'networkidle0',
    timeout: timeoutMs,
  });

  const pointsXPath = '/html/body/main/div[1]/div[1]/div[2]/div/div[2]/div[1]/a/span[1]/span[1]/span[2]';
  const cashXPath = '/html/body/main/div[1]/div[1]/div[2]/div/div[2]/div[1]/div[4]/span[2]';

  const pointsText = await waitForXPathText(page, pointsXPath, timeoutMs);
  const cashText = await waitForXPathText(page, cashXPath, timeoutMs);

  console.log(`[capture] points: ${pointsText} | cash: ${cashText}`);

  return {
    points: pointsText,
    cash: cashText,
    url: page.url(),
  };
}

module.exports = {
  captureAccountData,
};
