#!/usr/bin/env node

/**
 * Batch-fetch multiple URLs over HTTP using a self-logged-in impit session.
 *
 * Reads a URLs file (one per line, '#' comments and blank lines ignored),
 * logs in via loginViaHttp, fetches each URL sequentially via fetchPageViaHttp,
 * writes a summary JSON, and closes the session.
 *
 * Usage:
 *   node scripts/firecrawl/explore-batch.js <urlsFile> [--timeout <ms>] [--dry-run]
 *
 * Examples:
 *   node scripts/firecrawl/explore-batch.js data/firecrawl/test-urls.txt
 *   node scripts/firecrawl/explore-batch.js data/firecrawl/test-urls.txt --timeout 60000
 *   node scripts/firecrawl/explore-batch.js data/firecrawl/test-urls.txt --dry-run
 *
 * The urlsFile should contain one URL per line. Lines starting with '#' are
 * treated as comments and skipped. Blank lines are ignored.
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

const log = createLogger('firecrawl:explore-batch');

// ── CLI arg parsing (no external deps) ──────────────────────────────
const args = process.argv.slice(2);

/** @type {{ urlsFile: string, timeout: number, dryRun: boolean }} */
const cli = {
  urlsFile: '',
  timeout: 30000,
  dryRun: false,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--timeout' && i + 1 < args.length) {
    cli.timeout = parseInt(args[++i], 10) || 30000;
  } else if (arg === '--dry-run') {
    cli.dryRun = true;
  } else if (arg.startsWith('--')) {
    console.error(`Warning: unknown flag "${arg}" — ignored`);
  } else if (!cli.urlsFile) {
    cli.urlsFile = arg;
  }
}

// ── Dry-run: print config and exit before validateConfig ────────────
if (cli.dryRun) {
  let urlCount = 0;
  if (cli.urlsFile) {
    try {
      const content = fs.readFileSync(cli.urlsFile, 'utf-8');
      const lines = content.split(/\r?\n/);
      const urls = lines
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
      urlCount = urls.length;
    } catch (e) {
      console.error(`Error reading urlsFile: ${e.message}`);
      process.exit(1);
    }
  }

  console.log('── Firecrawl Batch HTTP Explore — Dry Run ──────────────');
  console.log(`  URLs file:        ${cli.urlsFile || '(none — required)'}`);
  console.log(`  URL count:        ${urlCount}`);
  console.log(`  Timeout:          ${cli.timeout}ms`);
  console.log(`  Auth mode:        HTTP (checkCredentials + impit)`);
  console.log(`  Profile name:     ${config.profileName}`);
  console.log(`  Location:         ${config.location.country} [${config.location.languages.join(', ')}]`);
  console.log(`  Request delay:    ${config.requestDelayMs}ms`);
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

    if (!cli.urlsFile) {
      log.error('URLs file is required. Usage: node scripts/firecrawl/explore-batch.js <urlsFile>');
      process.exitCode = 1; return;
    }

    // Read and parse URLs file
    let urls;
    try {
      const content = fs.readFileSync(cli.urlsFile, 'utf-8');
      urls = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
    } catch (e) {
      log.error(`Failed to read urlsFile "${cli.urlsFile}": ${e.message}`);
      process.exitCode = 1; return;
    }

    if (urls.length === 0) {
      log.error('No URLs found in urlsFile (comments and blank lines ignored).');
      process.exitCode = 1; return;
    }

    // Validate required env vars for HTTP auth
    if (!process.env.TEST_EMAIL) {
      log.error('TEST_EMAIL is required — set it in .env');
      process.exitCode = 1; return;
    }
    if (!process.env.TEST_PASSWORD) {
      log.error('TEST_PASSWORD is required — set it in .env');
      process.exitCode = 1; return;
    }
    if (!process.env.TARGET_LOGIN_URL) {
      log.error('TARGET_LOGIN_URL is required — set it in .env');
      process.exitCode = 1; return;
    }

    // Login via HTTP
    log.info('Logging in via HTTP...');
    const loginResult = await loginViaHttp(
      { email: process.env.TEST_EMAIL, password: process.env.TEST_PASSWORD },
      { targetUrl: process.env.TARGET_LOGIN_URL, timeoutMs: 60000 },
    );

    if (!loginResult.success) {
      log.error(`Login failed: ${loginResult.error || loginResult.message}`);
      process.exitCode = 1; return;
    }

    session = loginResult.session;
    log.info(`Starting HTTP batch fetch: ${urls.length} URL(s)`);

    // Fetch each URL sequentially
    const results = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const result = await fetchPageViaHttp(url, session, { timeout: cli.timeout });
      results.push({
        url,
        success: result.success,
        statusCode: result.metadata?.statusCode,
        rawHtmlLength: result.rawHtml?.length || 0,
        linksCount: result.links?.length || 0,
        error: result.error,
      });
      log.info(`[${i + 1}/${urls.length}] ${result.success ? 'OK' : 'FAIL'} ${url} → ${result.metadata?.statusCode}`);
    }

    // Compute summary
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    // Write summary JSON
    const ts = new Date();
    const fileSafeTs = ts.toISOString().replace(/[:.]/g, '-');
    const filename = `batch-http-${fileSafeTs}.json`;
    const dir = path.resolve(__dirname, '..', '..', 'data', 'firecrawl');
    fs.mkdirSync(dir, { recursive: true });
    const outputFile = path.join(dir, filename);

    const summary = {
      metadata: {
        timestamp: ts.toISOString(),
        configHash: config.hash,
        authed: true,
        source: 'http',
        total: results.length,
        succeeded,
        failed,
      },
      results,
    };

    fs.writeFileSync(outputFile, JSON.stringify(summary, null, 2), 'utf-8');

    // Print summary
    console.log(`\n✓ HTTP batch fetch complete`);
    console.log(`  Total:       ${results.length}`);
    console.log(`  Succeeded:   ${succeeded}`);
    console.log(`  Failed:      ${failed}`);
    console.log(`  Output file: ${outputFile}`);

    if (failed > 0) {
      console.log('\n  Failed URLs:');
      for (const r of results) {
        if (!r.success) {
          console.log(`    ✗ ${r.url} — ${r.error}`);
        }
      }
    }
  } catch (err) {
    log.error(`Batch fetch failed: ${err.message}`);
    if (err.stack) log.debug(err.stack);
    process.exitCode = 1; return;
  } finally {
    closeHttpSession(session);
  }
})().then(() => process.exit(process.exitCode || 0));
