// LOCAL-ONLY: not for production services.
// @ts-check

'use strict';

const fs = require('fs');
const path = require('path');
const { getClient } = require('./client');
const { config } = require('./config');
const { loadProfileMetadata } = require('./auth');
const { createLogger } = require('../shared/logger');

const log = createLogger('firecrawl:scrape');

/**
 * Compute a filesystem-safe slug from a URL (hostname + pathname simplified).
 * Replaces non-alphanumeric chars with '-', collapses runs, max 50 chars.
 *
 * @param {string} urlStr
 * @returns {string}
 */
function urlToSlug(urlStr) {
  try {
    const u = new URL(urlStr);
    const raw = u.hostname + u.pathname;
    const slug = raw.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return slug.slice(0, 50).replace(/-+$/g, '');
  } catch {
    return 'unknown';
  }
}

/**
 * Scrapes a single page via Firecrawl's /v2/scrape endpoint.
 *
 * Supports public (no profile) and authenticated (saved Firecrawl profile)
 * scraping. If `profile` is a string, it is used as the profile name. If
 * `profile` is `true`, the profile name is loaded from `config.profileName`
 * via `loadProfileMetadata`. If `profile` is `null`/`false`/`undefined`, no
 * profile is used (public scrape).
 *
 * @param {string} url - The URL to scrape.
 * @param {object} [options={}] - Scrape options.
 * @param {string|boolean|null} [options.profile=null] - Profile name (string), `true` (use config), or null/undefined (public).
 * @param {string[]} [options.formats=['markdown']] - Output formats for Firecrawl.
 * @param {boolean} [options.onlyMainContent=true] - Extract only the main content of the page.
 * @param {number} [options.timeout=60000] - Timeout in milliseconds.
 * @param {boolean} [options.screenshot=false] - Include screenshot in results.
 * @param {boolean} [options.saveOutput=true] - Write output JSON to data/firecrawl/.
 * @returns {Promise<object>} Scrape result with metadata.
 */
async function scrapePage(url, options = {}) {
  const {
    profile = null,
    formats = ['markdown'],
    onlyMainContent = true,
    timeout = 60000,
    screenshot = false,
    saveOutput = true,
  } = options;

  // Resolve profile name
  /** @type {string|null} */
  let profileName = null;

  if (typeof profile === 'string') {
    profileName = profile;
  } else if (profile === true) {
    const meta = loadProfileMetadata(config.profileName);
    if (meta) {
      profileName = config.profileName;
    } else {
      log.warn('No saved profile metadata found. Continuing as public scrape.');
    }
  }
  // else null/false/undefined => public scrape (no profile)

  // Build scrape options
  const resolvedFormats = screenshot ? [...new Set([...formats, 'screenshot'])] : formats;

  /** @type {import('firecrawl').ScrapeOptions} */
  const scrapeOpts = {
    formats: resolvedFormats,
    location: config.location,
    proxy: config.proxy,
    onlyMainContent,
    timeout,
  };

  if (profileName) {
    scrapeOpts.profile = { name: profileName, saveChanges: false };
  }

  log.info(`Scraping ${url} ${profileName ? `(authed, profile=${profileName})` : '(public)'}`);

  const result = await getClient().scrape(url, scrapeOpts);

  // Extract fields from the Document result
  const extracted = {
    url: result?.metadata?.sourceURL || url,
    markdown: result?.markdown || null,
    html: result?.html || null,
    rawHtml: result?.rawHtml || null,
    links: result?.links || [],
    images: result?.images || [],
    screenshot: result?.screenshot || null,
    metadata: result?.metadata || {},
  };

  // Write output file if requested
  let outputFile = null;
  if (saveOutput) {
    const ts = new Date();
    const fileSafeTs = ts.toISOString().replace(/[:.]/g, '-');
    const slug = urlToSlug(url);
    const filename = `scrape-${slug}-${fileSafeTs}.json`;
    const dir = path.resolve(__dirname, '..', '..', 'data', 'firecrawl');
    fs.mkdirSync(dir, { recursive: true });
    outputFile = path.join(dir, filename);

    const output = {
      metadata: {
        timestamp: ts.toISOString(),
        configHash: config.hash,
        profileName: profileName || null,
        url,
        authed: !!profileName,
      },
      ...extracted,
    };

    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf-8');
    log.info(`Scrape output saved to ${outputFile}`);
  }

  return {
    ...extracted,
    outputFile,
    success: true,
  };
}

/**
 * Scrapes multiple URLs sequentially (default concurrency=1) and returns a
 * summary object. Each URL is scraped via scrapePage with saveOutput: true.
 *
 * @param {string[]} urls - Array of URLs to scrape.
 * @param {object} [options={}] - Scrape options (same as scrapePage, plus concurrency).
 * @param {number} [options.concurrency=1] - Number of concurrent scrapes (default 1 — sequential).
 * @returns {Promise<{ total: number, succeeded: number, failed: number, results: Array<object>, outputFile?: string }>}
 */
async function scrapeBatch(urls, options = {}) {
  const { concurrency = 1, ...scrapeOptions } = options;

  const summary = {
    total: urls.length,
    succeeded: 0,
    failed: 0,
    results: [],
  };

  // For concurrency=1 (default), simple sequential loop.
  // For higher concurrency, run in batches.
  if (concurrency <= 1) {
    for (const url of urls) {
      try {
        const result = await scrapePage(url, { ...scrapeOptions, saveOutput: true });
        summary.results.push(result);
        summary.succeeded++;
        log.info(`[${summary.succeeded + summary.failed}/${urls.length}] OK: ${url}`);
      } catch (err) {
        summary.failed++;
        log.warn(`[${summary.succeeded + summary.failed}/${urls.length}] FAIL: ${url} — ${err.message}`);
        summary.results.push({ url, success: false, error: err.message });
      }
    }
  } else {
    // Batch concurrent: process in chunks of `concurrency`
    for (let i = 0; i < urls.length; i += concurrency) {
      const chunk = urls.slice(i, i + concurrency);
      const chunkResults = await Promise.allSettled(
        chunk.map((url) => scrapePage(url, { ...scrapeOptions, saveOutput: true })),
      );

      for (let j = 0; j < chunkResults.length; j++) {
        const settled = chunkResults[j];
        const url = chunk[j];
        if (settled.status === 'fulfilled') {
          summary.results.push(settled.value);
          summary.succeeded++;
          log.info(`[${summary.succeeded + summary.failed}/${urls.length}] OK: ${url}`);
        } else {
          summary.failed++;
          log.warn(`[${summary.succeeded + summary.failed}/${urls.length}] FAIL: ${url} — ${settled.reason?.message || settled.reason}`);
          summary.results.push({ url, success: false, error: settled.reason?.message || String(settled.reason) });
        }
      }
    }
  }

  // Write batch summary
  const ts = new Date();
  const fileSafeTs = ts.toISOString().replace(/[:.]/g, '-');
  const filename = `batch-${fileSafeTs}.json`;
  const dir = path.resolve(__dirname, '..', '..', 'data', 'firecrawl');
  fs.mkdirSync(dir, { recursive: true });
  const outputFile = path.join(dir, filename);

  const batchOutput = {
    metadata: {
      timestamp: ts.toISOString(),
      configHash: config.hash,
      profileName: config.profileName,
      total: summary.total,
      succeeded: summary.succeeded,
      failed: summary.failed,
      concurrency,
    },
    results: summary.results,
  };

  fs.writeFileSync(outputFile, JSON.stringify(batchOutput, null, 2), 'utf-8');
  log.info(`Batch summary saved to ${outputFile}`);

  return { ...summary, outputFile };
}

module.exports = { scrapePage, scrapeBatch };
