#!/usr/bin/env node

/**
 * Scrape a single page using a saved Firecrawl profile (authenticated).
 *
 * Usage:
 *   node scripts/firecrawl/scrape-authed.js <url> [--formats <list>] [--screenshot] [--no-main-content] [--profile <name>] [--dry-run]
 *
 * Examples:
 *   node scripts/firecrawl/scrape-authed.js https://www.rakuten.co.jp
 *   node scripts/firecrawl/scrape-authed.js https://www.rakuten.co.jp --screenshot
 *   node scripts/firecrawl/scrape-authed.js https://www.rakuten.co.jp --formats markdown,html --screenshot
 *   node scripts/firecrawl/scrape-authed.js https://www.rakuten.co.jp --dry-run
 *   node scripts/firecrawl/scrape-authed.js https://www.rakuten.co.jp --profile my-custom-profile
 *
 * Default profile: FIRECRAWL_PROFILE_NAME from .env (or 'rakuten-explorer').
 */

// Load dotenv FIRST — two levels deep from root (scripts/firecrawl/)
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { config, validateConfig } = require('../../src/firecrawl/config');
const { scrapePage } = require('../../src/firecrawl/scrape');
const { loadProfileMetadata } = require('../../src/firecrawl/auth');
const { createLogger } = require('../../src/shared/logger');

const log = createLogger('firecrawl:scrape-authed');

// ── CLI arg parsing (no external deps) ──────────────────────────────
const args = process.argv.slice(2);

/** @type {{ url: string, formats: string[], screenshot: boolean, onlyMainContent: boolean, profileName: string|null, dryRun: boolean }} */
const cli = {
  url: '',
  formats: ['markdown'],
  screenshot: false,
  onlyMainContent: true,
  profileName: null,
  dryRun: false,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--formats' && i + 1 < args.length) {
    cli.formats = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
  } else if (arg === '--screenshot') {
    cli.screenshot = true;
  } else if (arg === '--no-main-content') {
    cli.onlyMainContent = false;
  } else if (arg === '--profile' && i + 1 < args.length) {
    cli.profileName = args[++i];
  } else if (arg === '--dry-run') {
    cli.dryRun = true;
  } else if (arg.startsWith('--')) {
    console.error(`Warning: unknown flag "${arg}" — ignored`);
  } else if (!cli.url) {
    cli.url = arg;
  }
}

// ── Dry-run: print config and exit before validateConfig ────────────
if (cli.dryRun) {
  const profileName = cli.profileName || config.profileName;
  const profileMeta = loadProfileMetadata(profileName);

  console.log('── Firecrawl Scrape (Authed) — Dry Run ───────────────');
  console.log(`  URL:              ${cli.url || '(none — required)'}`);
  console.log(`  Formats:          ${cli.formats.join(', ')}`);
  console.log(`  Screenshot:       ${cli.screenshot ? 'YES' : 'no'}`);
  console.log(`  Only main content: ${cli.onlyMainContent ? 'YES' : 'no'}`);
  console.log(`  Profile name:     ${profileName}`);
  console.log(`  Location:         ${config.location.country} [${config.location.languages.join(', ')}]`);
  console.log(`  Request delay:    ${config.requestDelayMs}ms`);
  console.log(`  API key set:      ${config.apiKey ? 'YES' : 'NO'}`);

  if (profileMeta) {
    console.log(`  Profile metadata: found (saved at ${profileMeta.savedAt})`);
  } else {
    console.log(`  Profile metadata: MISSING`);
    console.log(`  → Run "node scripts/firecrawl/login.js" first to save a profile.`);
    console.log(`  → Continuing without profile will do a public scrape.`);
  }

  console.log('───────────────────────────────────────────────────────');
  process.exit(0);
}

// ── Main ─────────────────────────────────────────────────────────────
(async () => {
  try {
    validateConfig();

    if (!cli.url) {
      log.error('URL is required. Usage: node scripts/firecrawl/scrape-authed.js <url>');
      process.exit(1);
    }

    const result = await scrapePage(cli.url, {
      profile: cli.profileName || true,
      formats: cli.formats,
      screenshot: cli.screenshot,
      onlyMainContent: cli.onlyMainContent,
    });

    console.log(`\n✓ Scrape successful`);
    console.log(`  URL:          ${result.url}`);
    console.log(`  Output file:  ${result.outputFile || '(not saved)'}`);

    if (result.markdown) {
      const preview = result.markdown.slice(0, 200).replace(/\n/g, ' ');
      console.log(`  Markdown:     ${preview}${result.markdown.length > 200 ? '...' : ''}`);
      console.log(`  Markdown len: ${result.markdown.length} chars`);
    } else {
      console.log('  Markdown:     (none)');
    }

    console.log(`  Screenshot:   ${result.screenshot ? `saved (${result.screenshot.length} bytes)` : 'no'}`);
  } catch (err) {
    log.error(`Scrape failed: ${err.message}`);
    if (err.stack) log.debug(err.stack);
    process.exit(1);
  }
})();
