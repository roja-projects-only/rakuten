#!/usr/bin/env node

/**
 * Map public Rakuten endpoints using Firecrawl's /v2/map endpoint.
 *
 * Usage:
 *   node scripts/firecrawl/map-public.js [baseUrl] [--search <term>] [--limit <n>] [--dry-run]
 *
 * Examples:
 *   node scripts/firecrawl/map-public.js
 *   node scripts/firecrawl/map-public.js --dry-run
 *   node scripts/firecrawl/map-public.js https://www.rakuten.co.jp --search "help" --limit 100
 *   node scripts/firecrawl/map-public.js --search "login" --dry-run
 */

// Load dotenv FIRST — two levels deep from root (scripts/firecrawl/)
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { config, validateConfig } = require('../../src/firecrawl/config');
const { mapAndSave } = require('../../src/firecrawl/map');
const { createLogger } = require('../../src/shared/logger');

const log = createLogger('firecrawl:map-public');

// ── CLI arg parsing (no external deps) ──────────────────────────────
const args = process.argv.slice(2);

let baseUrl = '';
let search = '';
let limit = 500;
let dryRun = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--search' && i + 1 < args.length) {
    search = args[++i];
  } else if (arg === '--limit' && i + 1 < args.length) {
    const parsed = parseInt(args[++i], 10);
    if (isNaN(parsed) || parsed < 1) {
      console.error(`Warning: invalid --limit value "${args[i]}", using default 500`);
      limit = 500;
    } else {
      limit = parsed;
    }
  } else if (arg === '--dry-run') {
    dryRun = true;
  } else if (arg.startsWith('--')) {
    console.error(`Warning: unknown flag "${arg}" — ignored`);
  } else if (!baseUrl) {
    baseUrl = arg;
  }
}

// Default baseUrl from TARGET_LOGIN_URL or fallback (safe — no throw on malformed env)
if (!baseUrl) {
  const targetLoginUrl = process.env.TARGET_LOGIN_URL;
  try {
    baseUrl = targetLoginUrl ? new URL(targetLoginUrl).origin : 'https://www.rakuten.co.jp';
  } catch {
    baseUrl = 'https://www.rakuten.co.jp';
  }
}

// ── Dry-run: print config and exit before validateConfig ────────────
// This lets users inspect their config even without an API key.
if (dryRun) {
  console.log('── Firecrawl Map — Dry Run ──────────────────────────');
  console.log(`  Base URL:         ${baseUrl}`);
  console.log(`  Search filter:    ${search || '(none)'}`);
  console.log(`  Limit:            ${limit}`);
  console.log(`  Profile name:     ${config.profileName}`);
  console.log(`  Location:         ${config.location.country} [${config.location.languages.join(', ')}]`);
  console.log(`  Request delay:    ${config.requestDelayMs}ms`);
  console.log(`  API key set:      ${config.apiKey ? 'YES' : 'NO'}`);
  console.log(`  Config hash:      ${config.hash}`);
  console.log('──────────────────────────────────────────────────────');
  process.exit(0);
}

// ── Main ────────────────────────────────────────────────────────────
(async () => {
  try {
    validateConfig();

    const result = await mapAndSave(baseUrl, { search, limit });

    console.log(`Found ${result.linkCount} link(s). Saved to ${result.filePath}`);
    console.log('');

    // Preview first 10 URLs
    const previewCount = Math.min(result.links.length, 10);
    if (previewCount > 0) {
      console.log('Preview (first 10):');
      for (let i = 0; i < previewCount; i++) {
        console.log(`  ${i + 1}. ${result.links[i].url}`);
      }
    }
    if (result.links.length > 10) {
      console.log(`  ... and ${result.links.length - 10} more`);
    }
  } catch (err) {
    log.error(`Map failed: ${err.message}`);
    if (err.stack) log.error(err.stack);
    process.exit(1);
  }
})();
