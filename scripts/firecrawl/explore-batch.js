#!/usr/bin/env node

/**
 * Batch-scrape multiple URLs using a saved Firecrawl profile (authenticated).
 *
 * Usage:
 *   node scripts/firecrawl/explore-batch.js <urlsFile> [--formats <list>] [--screenshot] [--concurrency <n>] [--dry-run]
 *
 * Examples:
 *   node scripts/firecrawl/explore-batch.js data/firecrawl/test-urls.txt
 *   node scripts/firecrawl/explore-batch.js data/firecrawl/test-urls.txt --screenshot
 *   node scripts/firecrawl/explore-batch.js data/firecrawl/test-urls.txt --formats markdown,html
 *   node scripts/firecrawl/explore-batch.js data/firecrawl/test-urls.txt --concurrency 3
 *   node scripts/firecrawl/explore-batch.js data/firecrawl/test-urls.txt --dry-run
 *
 * The urlsFile should contain one URL per line. Lines starting with '#' are
 * treated as comments and skipped. Blank lines are ignored.
 */

// Load dotenv FIRST — two levels deep from root (scripts/firecrawl/)
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { config, validateConfig } = require('../../src/firecrawl/config');
const { scrapeBatch } = require('../../src/firecrawl/scrape');
const { loadProfileMetadata } = require('../../src/firecrawl/auth');
const { createLogger } = require('../../src/shared/logger');

const log = createLogger('firecrawl:explore-batch');

// ── CLI arg parsing (no external deps) ──────────────────────────────
const args = process.argv.slice(2);

/** @type {{ urlsFile: string, formats: string[], screenshot: boolean, concurrency: number, dryRun: boolean }} */
const cli = {
  urlsFile: '',
  formats: ['markdown'],
  screenshot: false,
  concurrency: 1,
  dryRun: false,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--formats' && i + 1 < args.length) {
    cli.formats = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
  } else if (arg === '--screenshot') {
    cli.screenshot = true;
  } else if (arg === '--concurrency' && i + 1 < args.length) {
    const parsed = parseInt(args[++i], 10);
    if (isNaN(parsed) || parsed < 1) {
      console.error(`Warning: invalid --concurrency value "${args[i]}", using default 1`);
      cli.concurrency = 1;
    } else {
      cli.concurrency = parsed;
    }
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

  console.log('── Firecrawl Batch Explore — Dry Run ─────────────────');
  console.log(`  URLs file:        ${cli.urlsFile || '(none — required)'}`);
  console.log(`  URL count:        ${urlCount}`);
  console.log(`  Formats:          ${cli.formats.join(', ')}`);
  console.log(`  Screenshot:       ${cli.screenshot ? 'YES' : 'no'}`);
  console.log(`  Concurrency:      ${cli.concurrency}`);
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
  try {
    validateConfig();

    // Pre-flight: check profile metadata exists
    const profileMeta = loadProfileMetadata(config.profileName);
    if (!profileMeta) {
      log.warn('No saved profile found. Run login.js first. Continuing as public scrape.');
    }

    if (!cli.urlsFile) {
      log.error('URLs file is required. Usage: node scripts/firecrawl/explore-batch.js <urlsFile>');
      process.exit(1);
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
      process.exit(1);
    }

    if (urls.length === 0) {
      log.error('No URLs found in urlsFile (comments and blank lines ignored).');
      process.exit(1);
    }

    log.info(`Starting batch scrape: ${urls.length} URL(s), concurrency=${cli.concurrency}`);

    const summary = await scrapeBatch(urls, {
      profile: true,
      formats: cli.formats,
      screenshot: cli.screenshot,
      concurrency: cli.concurrency,
    });

    console.log(`\n✓ Batch scrape complete`);
    console.log(`  Total:       ${summary.total}`);
    console.log(`  Succeeded:   ${summary.succeeded}`);
    console.log(`  Failed:      ${summary.failed}`);
    console.log(`  Output file: ${summary.outputFile}`);

    if (summary.failed > 0) {
      console.log('\n  Failed URLs:');
      for (const r of summary.results) {
        if (!r.success) {
          console.log(`    ✗ ${r.url} — ${r.error}`);
        }
      }
    }
  } catch (err) {
    log.error(`Batch scrape failed: ${err.message}`);
    if (err.stack) log.debug(err.stack);
    process.exit(1);
  }
})();
