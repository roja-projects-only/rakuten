#!/usr/bin/env node

// LOCAL-ONLY: not for production services.
// @ts-check

'use strict';

// Load dotenv FIRST — two levels deep from root (scripts/firecrawl/)
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { config, validateConfig } = require('../../src/firecrawl/config');
const { scrapePage, fetchPageViaHttp } = require('../../src/firecrawl/scrape');
const { mapSite } = require('../../src/firecrawl/map');
const { loginViaHttp, closeHttpSession } = require('../../src/firecrawl/auth');
const {
  extractEndpoints,
  extractNewUrls,
  groupEndpoints,
  formatEndpointsMd,
  isApiLike,
} = require('../../src/firecrawl/extract');
const {
  loadProgress,
  saveProgress,
  initProgress,
  isCreditExhaustedError,
  prependToQueue,
} = require('../../src/firecrawl/progress');
const { createLogger } = require('../../src/shared/logger');

const log = createLogger('firecrawl:discovery');

// ─── Helpers ─────────────────────────────────────────────────────────

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

// ─── CLI arg parsing (no external deps) ──────────────────────────────

const args = process.argv.slice(2);

/** @type {{ dryRun: boolean, relogin: boolean, batchSize: number, reloginIntervalMin: number, saveFailures: boolean }} */
const cli = {
  dryRun: false,
  relogin: false,
  batchSize: 20,
  reloginIntervalMin: 10,
  saveFailures: false,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--dry-run') {
    cli.dryRun = true;
  } else if (arg === '--relogin') {
    cli.relogin = true;
  } else if (arg === '--batch-size' && i + 1 < args.length) {
    const parsed = parseInt(args[++i], 10);
    if (isNaN(parsed) || parsed < 1) {
      console.error(`Warning: invalid --batch-size value "${args[i]}", using default 20`);
      cli.batchSize = 20;
    } else {
      cli.batchSize = parsed;
    }
  } else if (arg === '--relogin-interval-min' && i + 1 < args.length) {
    const parsed = parseInt(args[++i], 10);
    if (isNaN(parsed) || parsed < 1) {
      console.error(`Warning: invalid --relogin-interval-min value "${args[i]}", using default 10`);
      cli.reloginIntervalMin = 10;
    } else {
      cli.reloginIntervalMin = parsed;
    }
  } else if (arg === '--save-failures') {
    cli.saveFailures = true;
  } else if (arg.startsWith('--')) {
    console.error(`Warning: unknown flag "${arg}" — ignored`);
  }
}

// ─── Dry-run: print plan and exit before any API calls ───────────────

if (cli.dryRun) {
  const TARGET_LOGIN_URL = process.env.TARGET_LOGIN_URL || '';
  const TEST_EMAIL = process.env.TEST_EMAIL || '';
  const TEST_PASSWORD = process.env.TEST_PASSWORD || '';

  let baseUrl = '';
  try {
    baseUrl = new URL(TARGET_LOGIN_URL).origin;
  } catch {
    baseUrl = '(unable to parse TARGET_LOGIN_URL)';
  }

  const publicSeedUrls = [
    'https://www.rakuten.co.jp/',
    'https://search.rakuten.co.jp/search/mall/?q=test',
    'https://product.rakuten.co.jp/',
  ];

  const authedSeedUrls = [
    'https://cart.rakuten.co.jp/',
    'https://my.rakuten.co.jp/',
    'https://order.rakuten.co.jp/',
  ];

  const knownApiPatterns = [
    'https://www.rakuten.co.jp/api/',
    'https://www.rakuten.co.jp/rest/',
    'https://www.rakuten.co.jp/v1/',
    'https://www.rakuten.co.jp/v2/',
    'https://www.rakuten.co.jp/service/',
    'https://www.rakuten.co.jp/gateway/',
    'https://www.rakuten.co.jp/ichiba/',
    'https://www.rakuten.co.jp/user/',
    'https://www.rakuten.co.jp/cart/',
    'https://www.rakuten.co.jp/order/',
    'https://www.rakuten.co.jp/product/',
    'https://www.rakuten.co.jp/search/',
    'https://www.rakuten.co.jp/auth/',
  ];

  const knownApiHosts = [
    'https://login.account.rakuten.com/v2/login/start',
    'https://login.account.rakuten.com/v2/login/complete',
    'https://login.account.rakuten.com/util/gc',
    'https://login.account.rakuten.com/sso/authorize',
    'https://api.cms.rakuten.co.jp/',
    'https://rat.rakuten.co.jp/',
  ];

  console.log('── Firecrawl API Discovery — Dry Run ─────────────────');
  console.log(`  Target login URL:     ${TARGET_LOGIN_URL || '(not set)'}`);
  console.log(`  Base URL:             ${baseUrl}`);
  console.log(`  Email:                ${TEST_EMAIL ? TEST_EMAIL.slice(0, 2) + '...' + TEST_EMAIL.slice(-2) : '(not set)'}`);
  console.log(`  Password:             ${TEST_PASSWORD ? '*****' : '(not set)'}`);
  console.log(`  Batch size:           ${cli.batchSize}`);
  console.log(`  Re-login interval:    ${cli.reloginIntervalMin} min`);
  console.log(`  Save failures:        ${cli.saveFailures ? 'YES' : 'no'}`);
  console.log(`  Force re-login:       ${cli.relogin ? 'YES' : 'no'}`);
  console.log(`  Auth mode:            HTTP (checkCredentials + impit)`);
  console.log(`  Location:             ${config.location.country} [${config.location.languages.join(', ')}]`);
  console.log(`  Request delay:        ${config.requestDelayMs}ms`);
  console.log(`  API key set:          ${config.apiKey ? 'YES' : 'NO'}`);
  console.log(`  Config hash:          ${config.hash}`);
  console.log('');
  console.log('  Seed URLs (public):');
  for (const url of publicSeedUrls) {
    console.log(`    - ${url}`);
  }
  console.log('  Seed URLs (authed):');
  for (const url of authedSeedUrls) {
    console.log(`    - ${url}`);
  }
  console.log('  Known API path patterns:');
  for (const url of knownApiPatterns) {
    console.log(`    - ${url}`);
  }
  console.log('  Known API hosts:');
  for (const url of knownApiHosts) {
    console.log(`    - ${url}`);
  }
  console.log('───────────────────────────────────────────────────────');
  process.exit(0);
}

// ─── Main ─────────────────────────────────────────────────────────────

(async () => {
  try {
    validateConfig();

    // ─── Required env vars ──────────────────────────────────────────

    const TARGET_LOGIN_URL = process.env.TARGET_LOGIN_URL;
    if (!TARGET_LOGIN_URL) {
      log.error('TARGET_LOGIN_URL is required. Set it in .env or as an environment variable.');
      process.exitCode = 1; return;
    }

    const TEST_EMAIL = process.env.TEST_EMAIL;
    if (!TEST_EMAIL) {
      log.error('TEST_EMAIL is required. Set it in .env or as an environment variable.');
      process.exitCode = 1; return;
    }

    const TEST_PASSWORD = process.env.TEST_PASSWORD;
    if (!TEST_PASSWORD) {
      log.error('TEST_PASSWORD is required. Set it in .env or as an environment variable.');
      process.exitCode = 1; return;
    }

    // Derive base URL from login URL
    let baseUrl;
    try {
      baseUrl = new URL(TARGET_LOGIN_URL).origin;
    } catch {
      log.error(`TARGET_LOGIN_URL is not a valid URL: "${TARGET_LOGIN_URL}"`);
      process.exitCode = 1; return;
    }

    // ─── State ──────────────────────────────────────────────────────

    /**
     * Shared mutable state. Initialised fresh or loaded from disk.
     * @type {object}
     */
    let state;
    /** @type {boolean} */
    let isResume = false;
    /**
     * Timestamp (ms since epoch) of the last successful login.
     * @type {number}
     */
    let loginTimestamp = 0;
    /**
     * Live HTTP session from loginViaHttp (impit session, held in memory).
     * @type {object|null}
     */
    let session = null;

    // ══════════════════════════════════════════════════════════════════
    // Phase 0: Resume Check
    // ══════════════════════════════════════════════════════════════════

    const savedState = loadProgress();

    if (savedState && savedState.status !== 'complete') {
      // Resume from saved state
      state = savedState;
      isResume = true;

      log.info('\n========== RESUMING DISCOVERY ==========');
      log.info(`  Batches completed: ${state.batches_completed || 0}`);
      log.info(`  URLs scraped:      ${Array.isArray(state.urls_scraped) ? state.urls_scraped.length : 0}`);
      log.info(`  URLs remaining:    ${Array.isArray(state.urls_queued) ? state.urls_queued.length : 0}`);
      log.info(`  URLs failed:       ${Array.isArray(state.urls_failed) ? state.urls_failed.length : 0}`);
      log.info(`  Endpoints found:   ${Array.isArray(state.endpoints_found) ? state.endpoints_found.length : 0}`);
      log.info('========================================\n');

      // Re-authenticate — the saved session is almost certainly expired
      log.info('Re-authenticating (saved session may have expired)...');
      const resumeLogin = await loginViaHttp(
        { email: TEST_EMAIL, password: TEST_PASSWORD },
        { targetUrl: TARGET_LOGIN_URL, timeoutMs: 60000 },
      );
      if (!resumeLogin.success) {
        log.error(`Re-login on resume failed: ${resumeLogin.error || resumeLogin.message}`);
        log.error('Cannot continue without authentication. Exiting.');
        process.exitCode = 1; return;
      }
      session = resumeLogin.session;
      loginTimestamp = Date.now();
      log.info('Re-login on resume successful.');

    } else if (savedState && savedState.status === 'complete') {
      log.info('Discovery already complete. Re-run with --relogin to start fresh.');
      process.exitCode = 0; return;
    } else {
      // Fresh start
      state = initProgress(baseUrl);
      isResume = false;

      // ════════════════════════════════════════════════════════════════
      // Phase 1: Authentication
      // ════════════════════════════════════════════════════════════════

      log.info('No existing session. Initiating login flow...');

      const loginResult = await loginViaHttp(
        { email: TEST_EMAIL, password: TEST_PASSWORD },
        { targetUrl: TARGET_LOGIN_URL, timeoutMs: 60000 },
      );

      if (!loginResult.success) {
        log.error(`Login failed: ${loginResult.error || loginResult.message || 'unknown error'}`);
        process.exitCode = 1; return;
      }

      session = loginResult.session;
      loginTimestamp = Date.now();
      log.info('HTTP login successful');

      // ─── Post-auth verification ───────────────────────────────────

      log.info('Performing post-auth verification...');
      const verifyResult = await fetchPageViaHttp('https://my.rakuten.co.jp/', session, { timeout: 30000 });

      // Check if result indicates login failure
      const redirectUrl = (verifyResult.url || '').toLowerCase();
      const rawHtml = (verifyResult.rawHtml || '').toLowerCase();

      if (
        redirectUrl.includes('login.account.rakuten.com') ||
        redirectUrl.includes('/sso/authorize') ||
        verifyResult.metadata?.statusCode === 302 ||
        verifyResult.metadata?.statusCode === 303 ||
        rawHtml.includes('ログイン') ||
        rawHtml.includes('sign in')
      ) {
        log.error('Post-auth verification failed — redirected to login page. Auth may have failed.');
        process.exitCode = 1; return;
      }

      log.info('Post-auth verification passed');

      // Extract endpoints from the verification scrape
      const verifyEndpoints = extractEndpoints(verifyResult);
      for (const ep of verifyEndpoints) {
        state.endpoints_found.push(ep);
      }
      log.info(`  Found ${verifyEndpoints.length} endpoints from verification page`);

      // ════════════════════════════════════════════════════════════════
      // Phase 2: Smart URL Seeding
      // ════════════════════════════════════════════════════════════════

      log.info('\n=== Phase 2: URL Seeding ===');

      /** @type {Set<string>} */
      const scrapedSet = new Set(state.urls_scraped || []);
      /** @type {Set<string>} */
      const queuedSet = new Set(state.urls_queued || []);

      // ── Priority 1: OpenAPI / Swagger check (direct HTTP, not Firecrawl) ──

      log.info('  Priority 1: Checking for OpenAPI/Swagger specs...');
      const specPaths = ['/api-docs', '/swagger.json', '/openapi.json', '/openapi.yaml'];
      for (const specPath of specPaths) {
        const specUrl = `${baseUrl}${specPath}`;
        try {
          const response = await fetch(specUrl, {
            method: 'GET',
            redirect: 'follow',
            signal: AbortSignal.timeout(10000),
          });
          if (response.ok) {
            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('json') || specPath.endsWith('.json')) {
              log.info(`  OpenAPI spec found at ${specUrl}`);
              try {
                const spec = await response.json();
                // Extract paths and methods from spec
                if (spec && spec.paths) {
                  for (const [p, methods] of Object.entries(spec.paths)) {
                    if (methods && typeof methods === 'object') {
                      for (const method of Object.keys(methods)) {
                        const upper = method.toUpperCase();
                        if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(upper)) {
                          state.endpoints_found.push({
                            method: upper,
                            path: p,
                            fullUrl: `${baseUrl}${p}`,
                            params: {},
                            source: `OpenAPI spec at ${specUrl}`,
                            inferred: false,
                          });
                        }
                      }
                    }
                  }
                  log.info(`    Parsed ${state.endpoints_found.length - (verifyEndpoints.length)} endpoints from OpenAPI spec`);
                }
              } catch (parseErr) {
                log.debug(`    Could not parse JSON spec: ${parseErr.message}`);
              }
            } else if (contentType.includes('yaml') || specPath.endsWith('.yaml')) {
              log.info(`  OpenAPI YAML spec found at ${specUrl} (auto-parsing not available)`);
            }
          }
        } catch (fetchErr) {
          log.debug(`  ${specUrl}: ${fetchErr.message}`);
        }
      }

      // ── Priority 2: Sitemap via Firecrawl map ────────────────────

      log.info('  Priority 2: Mapping site via Firecrawl...');

      try {
        const apiLinks = await mapSite(baseUrl, { limit: 500, search: 'api' });
        const apiLikeLinks = apiLinks.filter((l) => isApiLike(l.url));
        for (const link of apiLikeLinks) {
          if (!scrapedSet.has(link.url) && !queuedSet.has(link.url)) {
            state.urls_queued.push(link.url);
            queuedSet.add(link.url);
          }
        }
        log.info(`    Found ${apiLikeLinks.length} API-like URLs from "api" search`);
      } catch (mapErr) {
        log.warn(`    mapSite search=api failed: ${mapErr.message}`);
      }

      try {
        const allLinks = await mapSite(baseUrl, { limit: 500 });
        const allApiLinks = allLinks.filter((l) => isApiLike(l.url));
        let addedCount = 0;
        for (const link of allApiLinks) {
          if (!scrapedSet.has(link.url) && !queuedSet.has(link.url)) {
            state.urls_queued.push(link.url);
            queuedSet.add(link.url);
            addedCount++;
          }
        }
        log.info(`    Added ${addedCount} more API-like URLs from full map`);
      } catch (mapErr) {
        log.warn(`    mapSite full failed: ${mapErr.message}`);
      }

      // ── Priority 3: JS Bundle Scanning ───────────────────────────

      log.info('  Priority 3: JS bundle scanning...');

      /** @type {Array<{ url: string, authed: boolean }>} */
      const seedPages = [
        { url: 'https://www.rakuten.co.jp/', authed: false },
        { url: 'https://search.rakuten.co.jp/search/mall/?q=test', authed: false },
        { url: 'https://product.rakuten.co.jp/', authed: false },
      ];

      /** @type {Array<{ url: string, authed: boolean }>} */
      const authedPages = [
        { url: 'https://cart.rakuten.co.jp/', authed: true },
        { url: 'https://my.rakuten.co.jp/', authed: true },
        { url: 'https://order.rakuten.co.jp/', authed: true },
      ];

      const allSeedPages = [...seedPages, ...authedPages];

      for (const page of allSeedPages) {
        try {
          const seedResult = await fetchPageViaHttp(page.url, session, { timeout: 60000 });

          // Extract endpoints from seed scrape
          const seedEndpoints = extractEndpoints(seedResult);
          for (const ep of seedEndpoints) {
            // Deduplicate against existing endpoints_found
            const existingUrls = new Set(state.endpoints_found.map((e) => e.fullUrl.toLowerCase()));
            if (!existingUrls.has(ep.fullUrl.toLowerCase())) {
              state.endpoints_found.push(ep);
            }
          }

          // Extract new URLs to queue
          const newUrls = extractNewUrls(seedResult, scrapedSet, queuedSet);
          for (const url of newUrls) {
            state.urls_queued.push(url);
            queuedSet.add(url);
          }

          log.info(`    Scraped ${page.url}: ${seedEndpoints.length} endpoints, ${newUrls.length} new URLs`);
        } catch (seedErr) {
          log.warn(`    Failed to scrape ${page.url}: ${seedErr.message}`);
        }
      }

      // ── Priority 4: Known Rakuten API patterns ───────────────────

      log.info('  Priority 4: Adding known API path patterns...');

      const apiPathPatterns = [
        '/api/', '/rest/', '/v1/', '/v2/', '/service/', '/gateway/',
        '/ichiba/', '/user/', '/cart/', '/order/', '/product/', '/search/', '/auth/',
      ];

      for (const pattern of apiPathPatterns) {
        const url = `https://www.rakuten.co.jp${pattern}`;
        if (!scrapedSet.has(url) && !queuedSet.has(url)) {
          state.urls_queued.push(url);
          queuedSet.add(url);
        }
      }

      const knownApiHosts = [
        'https://login.account.rakuten.com/v2/login/start',
        'https://login.account.rakuten.com/v2/login/complete',
        'https://login.account.rakuten.com/util/gc',
        'https://login.account.rakuten.com/sso/authorize',
        'https://api.cms.rakuten.co.jp/',
        'https://rat.rakuten.co.jp/',
      ];

      for (const url of knownApiHosts) {
        if (!scrapedSet.has(url) && !queuedSet.has(url)) {
          state.urls_queued.push(url);
          queuedSet.add(url);
        }
      }

      log.info(`    Added ${apiPathPatterns.length + knownApiHosts.length} known API URLs`);

      // ─── Save progress after seeding ─────────────────────────────

      saveProgress(state);
      log.info(`  Seeding complete: ${state.urls_queued.length} URLs queued, ${state.endpoints_found.length} endpoints found from seed pages`);
    }

    // ══════════════════════════════════════════════════════════════════
    // Phase 3: Batched Scraping Loop
    // ══════════════════════════════════════════════════════════════════

    // Initialise tracking sets from state (supports resume)
    /** @type {Set<string>} */
    const scrapedSet = new Set(state.urls_scraped || []);
    /** @type {Set<string>} */
    const queuedSet = new Set(state.urls_queued || []);

    // ─── Helper: checkAndReLogin ───────────────────────────────────

    /**
     * Check whether the HTTP session has expired and re-login if the
     * elapsed time since the last login exceeds the configured interval.
     *
     * @returns {Promise<void>}
     */
    async function checkAndReLogin() {
      const elapsedMin = (Date.now() - loginTimestamp) / 60000;
      if (elapsedMin >= cli.reloginIntervalMin) {
        log.info(`Session may have expired (${elapsedMin.toFixed(1)} min since login). Re-logging in...`);
        closeHttpSession(session);
        session = null;
        const result = await loginViaHttp(
          { email: TEST_EMAIL, password: TEST_PASSWORD },
          { targetUrl: TARGET_LOGIN_URL, timeoutMs: 60000 },
        );
        if (!result.success) {
          log.error('Re-login failed');
          throw new Error('Re-login failed: ' + (result.error || 'unknown'));
        }
        session = result.session;
        loginTimestamp = Date.now();
        log.info('Re-login successful');
      }
    }

    // ─── Helper: isAuthFailure ─────────────────────────────────────

    /**
     * Check whether a fetch result indicates an auth redirect (session expired)
     * or a Cloudflare challenge.
     *
     * @param {{ url?: string, rawHtml?: string, metadata?: { statusCode?: number } }|null} result
     * @returns {boolean}
     */
    function isAuthFailure(result) {
      if (!result) return false;

      // Check HTTP status code for redirect
      const statusCode = result.metadata?.statusCode;
      if (statusCode === 302 || statusCode === 303) return true;

      // Check URL for login redirect
      const url = (result.url || '').toLowerCase();
      if (url.includes('login.account.rakuten.com') || url.includes('/sso/authorize')) return true;

      // Check rawHtml for Cloudflare challenge markers
      const rawHtml = (result.rawHtml || '').toLowerCase();
      if (
        rawHtml.includes('cf-challenge') ||
        rawHtml.includes('just a moment') ||
        rawHtml.includes('_cf_chl_opt') ||
        rawHtml.includes('challenge-platform')
      ) return true;

      return false;
    }

    // ─── Helper: writeOutput ───────────────────────────────────────

    /**
     * Write the current state of discovered endpoints to `docs/api-endpoints.md`.
     */
    function writeOutput() {
      const grouped = groupEndpoints(state.endpoints_found);
      const md = formatEndpointsMd(grouped, {
        status: state.status || 'in_progress',
        batchesCompleted: state.batches_completed || 0,
        urlsScraped: Array.isArray(state.urls_scraped) ? state.urls_scraped.length : 0,
        urlsRemaining: Array.isArray(state.urls_queued) ? state.urls_queued.length : 0,
        endpointsFound: Array.isArray(state.endpoints_found) ? state.endpoints_found.length : 0,
        lastUpdated: state.last_updated || new Date().toISOString(),
      });
      const outputPath = path.resolve(__dirname, '..', '..', 'docs', 'api-endpoints.md');
      fs.writeFileSync(outputPath, md, 'utf-8');
      log.info(`Output written to ${outputPath}`);
    }

    // ─── Helper: printSummary ──────────────────────────────────────

    /**
     * Print a final summary of the discovery run to the log.
     */
    function printSummary() {
      log.info('\n========== DISCOVERY SUMMARY ==========');
      log.info(`  Status:             ${state.status}`);
      log.info(`  Batches completed:  ${state.batches_completed || 0}`);
      log.info(`  URLs scraped:       ${Array.isArray(state.urls_scraped) ? state.urls_scraped.length : 0}`);
      log.info(`  URLs remaining:     ${Array.isArray(state.urls_queued) ? state.urls_queued.length : 0}`);
      log.info(`  URLs failed:        ${Array.isArray(state.urls_failed) ? state.urls_failed.length : 0}`);
      if (Array.isArray(state.urls_failed) && state.urls_failed.length > 0) {
        for (const u of state.urls_failed) {
          log.info(`    - ${u}`);
        }
      }
      log.info(`  Total endpoints:    ${Array.isArray(state.endpoints_found) ? state.endpoints_found.length : 0}`);
      log.info(`  Output:             docs/api-endpoints.md`);
      log.info(`  Progress:           docs/api-scrape-progress.json`);
      log.info('========================================\n');
    }

    // ─── Main loop ────────────────────────────────────────────────

    while (state.urls_queued.length > 0) {
      // Take next batch
      const batch = state.urls_queued.splice(0, cli.batchSize);
      state.current_batch = batch;
      saveProgress(state);

      log.info(`\n=== Batch ${(state.batches_completed || 0) + 1} (${batch.length} URLs) ===`);

      /** @type {Array<object>} */
      let batchEndpoints = [];
      /** @type {Array<string>} */
      let batchFailed = [];

      for (let i = 0; i < batch.length; i++) {
        const url = batch[i];
        log.info(`  [${i + 1}/${batch.length}] ${url}`);

        try {
          // Session expiry check (per-URL, not per-batch)
          try {
            await checkAndReLogin();
          } catch (reloginErr) {
            // Re-login failure is fatal — stop the entire run
            log.error(`Re-login failed, stopping: ${reloginErr.message}`);
            state.status = 'paused_auth_failure';
            saveProgress(state);
            writeOutput();
            printSummary();
            process.exitCode = 1; return;
          }

          // Fetch page via HTTP using the live session
          const result = await fetchPageViaHttp(url, session, { timeout: 60000 });

          // Check for auth failure (redirected to login) or Cloudflare challenge
          if (isAuthFailure(result)) {
            log.warn('  Auth failure or Cloudflare challenge detected. Re-logging in...');
            closeHttpSession(session);
            session = null;
            const reLoginResult = await loginViaHttp(
              { email: TEST_EMAIL, password: TEST_PASSWORD },
              { targetUrl: TARGET_LOGIN_URL, timeoutMs: 60000 },
            );
            if (reLoginResult.success) {
              session = reLoginResult.session;
              loginTimestamp = Date.now();

              // Retry this URL
              const retryResult = await fetchPageViaHttp(url, session, { timeout: 60000 });

              if (isAuthFailure(retryResult)) {
                log.warn('  Still failing after re-login. Marking as failed.');
                batchFailed.push(url);
                continue;
              }

              // Process retry result
              const endpoints = extractEndpoints(retryResult);
              batchEndpoints.push(...endpoints);
              const newUrls = extractNewUrls(retryResult, scrapedSet, queuedSet);
              for (const u of newUrls) {
                state.urls_queued.push(u);
                queuedSet.add(u);
              }
              state.urls_scraped.push(url);
              scrapedSet.add(url);
              continue;
            } else {
              log.error(`  Re-login failed: ${reLoginResult.error || reLoginResult.message}`);
              batchFailed.push(url);
              continue;
            }
          }

          // Extract endpoints
          const endpoints = extractEndpoints(result);
          batchEndpoints.push(...endpoints);

          // Extract new URLs to queue
          const newUrls = extractNewUrls(result, scrapedSet, queuedSet);
          for (const u of newUrls) {
            state.urls_queued.push(u);
            queuedSet.add(u);
          }

          // Mark as scraped
          state.urls_scraped.push(url);
          scrapedSet.add(url);

          log.info(`    OK: ${endpoints.length} endpoints, ${newUrls.length} new URLs`);

        } catch (err) {
          // Check for credit exhaustion FIRST
          if (isCreditExhaustedError(err)) {
            log.error(`\n⚠️  CREDIT EXHAUSTION DETECTED: ${err.message}`);
            // Put remaining URLs in this batch back to the front of the queue
            const remaining = batch.slice(i); // includes current URL
            prependToQueue(state, remaining);
            state.current_batch = [];
            state.status = 'paused_credit_exhausted';
            saveProgress(state);
            // Write partial output
            writeOutput();
            printSummary();
            log.info('Stopped gracefully due to credit exhaustion.');
            process.exitCode = 0; return;
          }

          // Regular error — mark as failed, continue
          log.warn(`    FAIL: ${err.message}`);
          batchFailed.push(url);

          if (cli.saveFailures) {
            try {
              const failedDir = path.resolve(__dirname, '..', '..', 'data', 'firecrawl', 'failed');
              fs.mkdirSync(failedDir, { recursive: true });
              const failFile = path.join(failedDir, `${Date.now()}-${urlToSlug(url)}.json`);
              fs.writeFileSync(failFile, JSON.stringify({ url, error: err.message, timestamp: new Date().toISOString() }, null, 2));
            } catch (e) { /* ignore */ }
          }
        }
      }

      // After batch: update state
      state.batches_completed = (state.batches_completed || 0) + 1;
      state.current_batch = [];
      state.urls_failed.push(...batchFailed);

      // Merge batch endpoints into state (dedup by fullUrl, case-insensitive)
      const existingUrls = new Set(state.endpoints_found.map((e) => e.fullUrl.toLowerCase()));
      for (const ep of batchEndpoints) {
        if (!existingUrls.has(ep.fullUrl.toLowerCase())) {
          state.endpoints_found.push(ep);
          existingUrls.add(ep.fullUrl.toLowerCase());
        }
      }

      // Save progress
      saveProgress(state);

      // Write output (full overwrite)
      writeOutput();

      // Print batch summary
      log.info(`\n--- Batch ${state.batches_completed} complete ---`);
      log.info(`  Scraped: ${batch.length - batchFailed.length}, Failed: ${batchFailed.length}`);
      log.info(`  New endpoints this batch: ${batchEndpoints.length}`);
      log.info(`  Total endpoints: ${state.endpoints_found.length}`);
      log.info(`  URLs remaining: ${state.urls_queued.length}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // Phase 5: Completion
    // ══════════════════════════════════════════════════════════════════

    state.status = 'complete';
    saveProgress(state);
    writeOutput();
    printSummary();

    log.info('Discovery complete. All URLs processed.');
  } catch (err) {
    log.error(`Discovery failed: ${err.message}`);
    if (err.stack) log.debug(err.stack);
    process.exitCode = 1; return;
  } finally {
    if (session) {
      closeHttpSession(session);
      session = null;
    }
  }
})().then(() => process.exit(process.exitCode || 0));
