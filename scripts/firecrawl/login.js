#!/usr/bin/env node

/**
 * Login to Rakuten via Firecrawl and persist the authenticated session.
 *
 * Usage:
 *   node scripts/firecrawl/login.js [loginUrl] [--email <email>] [--password <pwd>] [--no-2fa] [--force-2fa-pause] [--code <file>] [--dry-run]
 *
 * Examples:
 *   node scripts/firecrawl/login.js
 *   node scripts/firecrawl/login.js --dry-run
 *   node scripts/firecrawl/login.js --no-2fa
 *   node scripts/firecrawl/login.js --force-2fa-pause
 *   node scripts/firecrawl/login.js --code ./custom-login-code.js
 *   node scripts/firecrawl/login.js https://example.com/login --email user@example.com --password pass
 *
 * Default credentials come from TEST_EMAIL and TEST_PASSWORD env vars.
 * Default loginUrl comes from TARGET_LOGIN_URL env var.
 */

// Load dotenv FIRST — two levels deep from root (scripts/firecrawl/)
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { config, validateConfig } = require('../../src/firecrawl/config');
const { loginAndPersist } = require('../../src/firecrawl/auth');
const { createLogger } = require('../../src/shared/logger');

const log = createLogger('firecrawl:login');

// ── CLI arg parsing (no external deps) ──────────────────────────────
const args = process.argv.slice(2);

/** @type {{ loginUrl: string, email: string, password: string, no2fa: boolean, force2faPause: boolean, codeFile: string|null, dryRun: boolean }} */
const cli = {
  loginUrl: '',
  email: '',
  password: '',
  no2fa: false,
  force2faPause: false,
  codeFile: null,
  dryRun: false,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--email' && i + 1 < args.length) {
    cli.email = args[++i];
  } else if (arg === '--password' && i + 1 < args.length) {
    cli.password = args[++i];
  } else if (arg === '--code' && i + 1 < args.length) {
    cli.codeFile = args[++i];
  } else if (arg === '--no-2fa') {
    cli.no2fa = true;
  } else if (arg === '--force-2fa-pause') {
    cli.force2faPause = true;
  } else if (arg === '--dry-run') {
    cli.dryRun = true;
  } else if (arg.startsWith('--')) {
    console.error(`Warning: unknown flag "${arg}" — ignored`);
  } else if (!cli.loginUrl) {
    cli.loginUrl = arg;
  }
}

// Apply defaults from env
cli.email = cli.email || process.env.TEST_EMAIL || '';
cli.password = cli.password || process.env.TEST_PASSWORD || '';

// Derive default loginUrl safely (try/catch like map-public.js)
if (!cli.loginUrl) {
  const targetLoginUrl = process.env.TARGET_LOGIN_URL;
  try {
    cli.loginUrl = targetLoginUrl || 'https://login.account.rakuten.com/sso/authorize?client_id=rakuten_ichiba_top_web&service_id=s245&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fwww.rakuten.co.jp%2F';
    // Validate it's a parseable URL
    new URL(cli.loginUrl);
  } catch {
    console.error(`Error: TARGET_LOGIN_URL or default loginUrl is not a valid URL`);
    process.exit(1);
  }
}

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
 * Returns a human-readable 2FA mode label.
 *
 * @param {{ no2fa: boolean, force2faPause: boolean }} opts
 * @returns {string}
 */
function twoFaModeLabel(opts) {
  if (opts.force2faPause) return 'forced pause';
  if (opts.no2fa) return 'disabled';
  return 'enabled (AI detection, fallback to manual pause)';
}

// ── Dry-run: print config and exit before validateConfig ────────────
if (cli.dryRun) {
  console.log('── Firecrawl Login — Dry Run ─────────────────────────');
  console.log(`  Login URL:        ${cli.loginUrl}`);
  console.log(`  Email:            ${maskEmail(cli.email)}`);
  console.log(`  Password:         ${cli.password ? '*****' : '(not set)'}`);
  console.log(`  2FA mode:         ${twoFaModeLabel(cli)}`);
  console.log(`  Code file:        ${cli.codeFile || '(none)'}`);
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

    // Check required credentials
    if (!cli.email || !cli.password) {
      log.error('EMAIL and PASSWORD are required. Set TEST_EMAIL/TEST_PASSWORD in .env or pass --email/--password.');
      process.exit(1);
    }

    const result = await loginAndPersist(cli.loginUrl, { email: cli.email, password: cli.password }, {
      no2fa: cli.no2fa,
      force2faPause: cli.force2faPause,
      codeFile: cli.codeFile,
    });

    if (result.success) {
      console.log(`\n✓ Login successful`);
      console.log(`  scrapeId:   ${result.scrapeId}`);
      console.log(`  profile:    ${result.profileName}`);
      if (result.outputFile) {
        console.log(`  output:     ${result.outputFile}`);
      }
      console.log('');
      console.log('⚠ Profile saved. Valid for ~15 minutes — run scrape-authed.js within that window.');
    } else {
      console.error(`\n✗ Login failed: ${result.error}`);
      process.exit(1);
    }
  } catch (err) {
    log.error('Unexpected error during login');
    log.debug(`Error details: ${err.message}`);
    if (err.stack) log.debug(err.stack);
    process.exit(1);
  }
})();
