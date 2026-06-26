// LOCAL-ONLY: not for production services.
// @ts-check

'use strict';

const fs = require('fs');
const path = require('path');
const { getClient } = require('./client');
const { config } = require('./config');
const { extractLinksFromHtml } = require('./extract');
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
 * Fetch a page over plain HTTP (no Firecrawl) using the given session's
 * HTTP client.  Returns a synthetic result object matching the shape that
 * `extractEndpoints()` consumes.
 *
 * @param {string} url - The URL to fetch.
 * @param {{ client: import('axios').AxiosInstance, proxiedClient?: import('axios').AxiosInstance }} session
 *   Session object with `.client` and/or `.proxiedClient`.
 * @param {object} [options={}] - Options.
 * @param {number} [options.timeout=30000] - Request timeout in ms.
 * @param {number} [options.maxRedirects=10] - Max redirects to follow.
 * @returns {Promise<{url: string, rawHtml: string, html: null, links: Array<{url: string}>, markdown: null, metadata: {statusCode: number}, success: boolean, error?: string}>}
 */
async function fetchPageViaHttp(url, session, options = {}) {
  const { timeout = 30000, maxRedirects = 10 } = options;

  const client = session.proxiedClient || session.client;

  const headers = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ja,en;q=0.8',
  };

  try {
    const response = await client.get(url, { timeout, headers, maxRedirects });

    log.info(`HTTP fetch ${url} → ${response.status}`);

    const rawHtml = typeof response.data === 'string'
      ? response.data
      : String(response.data ?? '');

    return {
      url: response.request?.res?.responseUrl || url,
      rawHtml,
      html: null,
      links: extractLinksFromHtml(rawHtml, url),
      markdown: null,
      metadata: { statusCode: response.status },
      success: response.status >= 200 && response.status < 400,
    };
  } catch (err) {
    log.warn(`HTTP fetch failed for ${url}: ${err.message}`);
    return {
      url,
      rawHtml: '',
      html: null,
      links: [],
      markdown: null,
      metadata: { statusCode: 0 },
      success: false,
      error: err.message,
    };
  }
}

/**
 * Scrapes a single page via Firecrawl's /v2/scrape endpoint.
 *
 * Supports public (no profile) and named-profile Firecrawl scraping.
 * `profile` accepts a profile name (string) or null/undefined (public scrape).
 * `profile === true` is no longer supported (HTTP auth pivot) and is treated
 * as a public scrape with a warning.
 *
 * @param {string} url - The URL to scrape.
 * @param {object} [options={}] - Scrape options.
 * @param {string|null} [options.profile=null] - Profile name (string) or null/undefined (public).
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
    log.warn('profile=true is no longer supported (HTTP auth pivot). Treating as public scrape.');
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

module.exports = { scrapePage, scrapeBatch, fetchPageViaHttp };
