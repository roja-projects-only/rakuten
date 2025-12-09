const puppeteer = require('puppeteer');
const UserAgent = require('user-agents');

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

function buildLaunchOptions(proxy, headless) {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ];

  if (proxy) {
    args.push(`--proxy-server=${proxy}`);
  }

  return {
    headless: headless ?? 'new',
    args,
  };
}

async function createBrowserSession({ proxy, headless } = {}) {
  const launchOptions = buildLaunchOptions(proxy, headless);
  const browser = await puppeteer.launch(launchOptions);
  // Puppeteer v24+ uses createBrowserContext for incognito; fall back for older versions.
  const contextFactory = browser.createBrowserContext || browser.createIncognitoBrowserContext;
  if (!contextFactory) {
    throw new Error('No browser context factory available on Puppeteer browser instance');
  }

  const context = await contextFactory.call(browser);
  const page = await context.newPage();

  await page.setViewport(DEFAULT_VIEWPORT);
  const userAgent = new UserAgent().toString();
  await page.setUserAgent(userAgent);

  return { browser, context, page };
}

async function closeBrowserSession(session) {
  if (!session) {
    return;
  }

  const { context, browser } = session;

  if (context) {
    await context.close().catch(() => {});
  }

  if (browser) {
    await browser.close().catch(() => {});
  }
}

module.exports = {
  buildLaunchOptions,
  createBrowserSession,
  closeBrowserSession,
};
