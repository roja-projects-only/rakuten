#!/usr/bin/env node

/**
 * Self-login and scrape a single URL via HTTP-based auth (no Firecrawl profile).
 *
 * Logs in via loginViaHttp, fetches a URL with fetchPageViaHttp, writes output JSON,
 * and releases the session.
 *
 * Usage:
 *   node scripts/firecrawl/scrape-authed.js <url> [--email <email>] [--password <pwd>] [--timeout <ms>] [--dry-run]
 *
 * Examples:
 *   node scripts/firecrawl/scrape-authed.js https://www.rakuten.co.jp
 *   node scripts/firecrawl/scrape-authed.js https://example.com --email user@example.com --password pass
 *   node scripts/firecrawl/scrape-authed.js https://example.com --timeout 60000 --dry-run
 *
 * Default credentials come from TEST_EMAIL and TEST_PASSWORD env vars.
 * Default login URL comes from TARGET_LOGIN_URL env var.
 */

// LOCAL-ONLY: not for production services.
// @ts-check

'use strict';

// Load dotenv FIRST — two levels deep from root (scripts/firecrawl/)
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const fs = require('fs');
const { config, validateConfig } = require('../../src/firecrawl/config');
const { loginViaHttp, closeHttpSession } = require('../../src/firecrawl/auth');
const { fetchPageViaHttp } = require('../../src/firecrawl/scrape');
const { createLogger } = require('../../src/shared/logger');

const log = createLogger('firecrawl:scrape-authed');

// ── CLI arg parsing (no external deps) ──────────────────────────────
const args = process.argv.slice(2);

/** @type {{ url: string, email: string, password: string, timeout: number, dryRun: boolean }} */
const cli = {
  url: '',
  email: '',
  password: '',
  timeout: 30000,
  dryRun: false,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--email' && i + 1 < args.length) {
    cli.email = args[++i];
  } else if (arg === '--password' && i + 1 < args.length) {
    cli.password = args[++i];
  } else if (arg === '--timeout' && i + 1 < args.length) {
    cli.timeout = parseInt(args[++i], 10) || 30000;
  } else if (arg === '--dry-run') {
    cli.dryRun = true;
  } else if (arg.startsWith('--')) {
    console.error(`Warning: unknown flag "${arg}" — ignored`);
  } else if (!cli.url) {
    cli.url = arg;
  }
}

// Apply defaults from env
cli.email = cli.email || process.env.TEST_EMAIL || '';
cli.password = cli.password || process.env.TEST_PASSWORD || '';

const targetLoginUrl = process.env.TARGET_LOGIN_URL || '';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Masks an email for display: first 2 + '...' + last 2 characters.
 * Returns '(not set)' for falsy values.
 *
 * @param {string} email
 * @returns {string}
 */
function maskEmail(email) {
  if (!email) return '(not set)';
  if (email.length <= 2) return '***';
  return email.slice(0, 2) + '...' + email.slice(-2);
}

/**
 * Compute a filesystem-safe slug from a URL.
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

// ── Dry-run: print config and exit before validateConfig ────────────
if (cli.dryRun) {
  console.log('── Firecrawl HTTP Scrape (Authed) — Dry Run ────────────');
  console.log(`  URL:              ${cli.url || '(none — required)'}`);
  console.log(`  Email:            ${maskEmail(cli.email)}`);
  console.log(`  Password:         ${cli.password ? '*****' : '(not set)'}`);
  console.log(`  Auth mode:        HTTP`);
  console.log(`  Timeout:          ${cli.timeout}ms`);
  console.log(`  Profile name:     ${config.profileName}`);
  console.log(`  Location:         ${config.location.country} [${config.location.languages.join(', ')}]`);
  console.log(`  API key set:      ${config.apiKey ? 'YES' : 'NO'}`);
  console.log(`  Config hash:      ${config.hash}`);
  console.log('───────────────────────────────────────────────────────');
  process.exit(0);
}

// ── Main ─────────────────────────────────────────────────────────────
(async () => {
  let session = null;

  try {
    validateConfig();

    if (!cli.url) {
      log.error('URL is required. Usage: node scripts/firecrawl/scrape-authed.js <url>');
      process.exitCode = 1; return;
    }

    if (!cli.email || !cli.password) {
      log.error('EMAIL and PASSWORD are required. Set TEST_EMAIL/TEST_PASSWORD in .env or pass --email/--password.');
      process.exitCode = 1; return;
    }

    if (!targetLoginUrl) {
      log.error('TARGET_LOGIN_URL is required — set it in .env');
      process.exitCode = 1; return;
    }

    // Login via HTTP
    log.info('Logging in via HTTP...');
    const loginResult = await loginViaHttp(
      { email: cli.email, password: cli.password },
      { targetUrl: targetLoginUrl, timeoutMs: 60000 },
    );

    if (!loginResult.success) {
      console.error(`\n✗ Login failed: ${loginResult.error || loginResult.message}`);
      process.exitCode = 1; return;
    }

    session = loginResult.session;
    log.info('Login successful, fetching page...');

    // Fetch the target page
    const result = await fetchPageViaHttp(cli.url, session, { timeout: cli.timeout });

    // Write output JSON
    const ts = new Date();
    const fileSafeTs = ts.toISOString().replace(/[:.]/g, '-');
    const slug = urlToSlug(cli.url);
    const filename = `scrape-http-${slug}-${fileSafeTs}.json`;
    const dir = path.resolve(__dirname, '..', '..', 'data', 'firecrawl');
    fs.mkdirSync(dir, { recursive: true });
    const outputFile = path.join(dir, filename);

    const output = {
      metadata: {
        timestamp: ts.toISOString(),
        configHash: config.hash,
        url: cli.url,
        authed: true,
        source: 'http',
      },
      url: result.url,
      rawHtmlLength: result.rawHtml.length,
      links: result.links,
      pageMetadata: result.metadata,
      success: result.success,
    };
    if (result.error) {
      output.error = result.error;
    }

    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf-8');
    log.info(`Scrape output saved to ${outputFile}`);

    // Print summary
    console.log(`\n✓ HTTP scrape completed`);
    console.log(`  URL:          ${result.url}`);
    console.log(`  Status code:  ${result.metadata.statusCode}`);
    console.log(`  Raw HTML:     ${result.rawHtml.length} bytes`);
    console.log(`  Links:        ${result.links.length}`);
    console.log(`  Output:       ${outputFile}`);
  } catch (err) {
    log.error(`Scrape-authed failed: ${err.message}`);
    if (err.stack) log.debug(err.stack);
    process.exitCode = 1; return;
  } finally {
    closeHttpSession(session);
  }
})().then(() => process.exit(process.exitCode || 0));
