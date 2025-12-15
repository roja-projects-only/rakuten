const puppeteer = require('puppeteer');
const UserAgent = require('user-agents');
const { createLogger } = require('../logger');

const log = createLogger('browser');

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
const DEFAULT_LIMITS = {
  maxAgeMs: 15 * 60 * 1000, // recycle after 15 minutes
  maxIdleMs: 10 * 60 * 1000, // recycle if idle for 10 minutes
  maxUses: 100, // recycle after N sessions
};

let sharedBrowser = null;
let sharedSignature = null;
let sharedLaunchedAt = 0;
let sharedLastUsedAt = 0;
let sharedUseCount = 0;

function parseLimit(envKey, fallback) {
  const val = process.env[envKey];
  if (!val) return fallback;
  const num = parseInt(val, 10);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function getLimits() {
  return {
    maxAgeMs: parseLimit('BROWSER_MAX_AGE_MS', DEFAULT_LIMITS.maxAgeMs),
    maxIdleMs: parseLimit('BROWSER_MAX_IDLE_MS', DEFAULT_LIMITS.maxIdleMs),
    maxUses: parseLimit('BROWSER_MAX_USES', DEFAULT_LIMITS.maxUses),
  };
}

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

function signatureFor(proxy, headless) {
  return JSON.stringify({ proxy: proxy || null, headless: headless ?? 'new' });
}

async function recycleSharedBrowser() {
  if (sharedBrowser) {
    try {
      await sharedBrowser.close();
    } catch (_) {
      // swallow
    }
  }
  sharedBrowser = null;
  sharedSignature = null;
  sharedLaunchedAt = 0;
  sharedLastUsedAt = 0;
  sharedUseCount = 0;
}

function needsRecycle(limits) {
  if (!sharedBrowser) return false;
  if (typeof sharedBrowser.isConnected === 'function' && !sharedBrowser.isConnected()) return true;
  const now = Date.now();
  if (limits.maxAgeMs && now - sharedLaunchedAt > limits.maxAgeMs) return true;
  if (limits.maxIdleMs && now - sharedLastUsedAt > limits.maxIdleMs) return true;
  if (limits.maxUses && sharedUseCount >= limits.maxUses) return true;
  return false;
}

async function getSharedBrowser(proxy, headless) {
  const limits = getLimits();
  const desiredSignature = signatureFor(proxy, headless);

  if (sharedBrowser && sharedSignature !== desiredSignature) {
    log.info('Browser signature changed, recycling existing browser');
    await recycleSharedBrowser();
  }

  if (needsRecycle(limits)) {
    log.info('Recycling browser due to age/idle/use limits');
    await recycleSharedBrowser();
  }

  if (!sharedBrowser) {
    const launchOptions = buildLaunchOptions(proxy, headless);
    sharedBrowser = await puppeteer.launch(launchOptions);
    sharedSignature = desiredSignature;
    sharedLaunchedAt = Date.now();
    sharedUseCount = 0;
    log.info('Launched shared browser');
  }

  sharedUseCount += 1;
  sharedLastUsedAt = Date.now();
  return { browser: sharedBrowser, limits };
}

async function createBrowserSession({ proxy, headless } = {}) {
  const attemptCreate = async (attempt = 1) => {
    const { browser } = await getSharedBrowser(proxy, headless);

    const contextFactory = browser.createBrowserContext || browser.createIncognitoBrowserContext;
    if (!contextFactory) {
      throw new Error('No browser context factory available on Puppeteer browser instance');
    }

    try {
      const context = await contextFactory.call(browser);
      const page = await context.newPage();

      await page.setViewport(DEFAULT_VIEWPORT);
      const userAgent = new UserAgent().toString();
      await page.setUserAgent(userAgent);

      return { browser, context, page, isShared: true };
    } catch (err) {
      // If Chromium was killed while idle, recycle and retry once.
      if (attempt === 1) {
        log.warn(`Browser session creation failed (attempt ${attempt}): ${err.message}`);
        await recycleSharedBrowser();
        return attemptCreate(attempt + 1);
      }
      throw err;
    }
  };

  return attemptCreate();
}

async function closeBrowserSession(session) {
  if (!session) {
    return;
  }

  const { context, browser, isShared } = session;

  if (context) {
    await context.close().catch(() => {});
  }

  if (!isShared && browser) {
    await browser.close().catch(() => {});
  }
}

async function closeSharedBrowser() {
  await recycleSharedBrowser();
}

module.exports = {
  buildLaunchOptions,
  createBrowserSession,
  closeBrowserSession,
  closeSharedBrowser,
};
