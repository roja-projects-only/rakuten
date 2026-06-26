#!/usr/bin/env node

/**
 * HTTP login smoke test — validates credentials via HTTP-based credential check.
 *
 * Usage:
 *   node scripts/firecrawl/login.js [loginUrl] [--email <email>] [--password <pwd>] [--dry-run]
 *
 * Examples:
 *   node scripts/firecrawl/login.js
 *   node scripts/firecrawl/login.js --dry-run
 *   node scripts/firecrawl/login.js https://login.example.com --email user@example.com --password pass
 *
 * Default credentials come from TEST_EMAIL and TEST_PASSWORD env vars.
 * Default loginUrl comes from TARGET_LOGIN_URL env var.
 */

// LOCAL-ONLY: not for production services.
// @ts-check

'use strict';

// Load dotenv FIRST — two levels deep from root (scripts/firecrawl/)
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { config, validateConfig } = require('../../src/firecrawl/config');
const { loginViaHttp, closeHttpSession, writeLoginOutput } = require('../../src/firecrawl/auth');
const { createLogger } = require('../../src/shared/logger');

const log = createLogger('firecrawl:login');

// ── CLI arg parsing (no external deps) ──────────────────────────────
const args = process.argv.slice(2);

/** @type {{ loginUrl: string, email: string, password: string, dryRun: boolean }} */
const cli = {
  loginUrl: '',
  email: '',
  password: '',
  dryRun: false,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--email' && i + 1 < args.length) {
    cli.email = args[++i];
  } else if (arg === '--password' && i + 1 < args.length) {
    cli.password = args[++i];
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

if (!cli.loginUrl) {
  cli.loginUrl = process.env.TARGET_LOGIN_URL || '';
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

// ── Dry-run: print config and exit before validateConfig ────────────
if (cli.dryRun) {
  console.log('── Firecrawl HTTP Login — Dry Run ─────────────────────');
  console.log(`  Login URL:        ${cli.loginUrl || '(not set)'}`);
  console.log(`  Email:            ${maskEmail(cli.email)}`);
  console.log(`  Password:         ${cli.password ? '*****' : '(not set)'}`);
  console.log(`  Auth mode:        HTTP (checkCredentials + impit)`);
  console.log(`  Profile name:     ${config.profileName}`);
  console.log(`  Location:         ${config.location.country} [${config.location.languages.join(', ')}]`);
  console.log(`  Request delay:    ${config.requestDelayMs}ms`);
  console.log(`  API key set:      ${config.apiKey ? 'YES' : 'NO'}`);
  console.log(`  Config hash:      ${config.hash}`);
  console.log('───────────────────────────────────────────────────────');
  process.exit(0);
}

// Validate loginUrl before proceeding
try {
  new URL(cli.loginUrl);
} catch {
  console.error(`Error: login URL is not a valid URL (set TARGET_LOGIN_URL in .env or pass as positional arg)`);
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────────
(async () => {
  try {
    validateConfig();

    // Check required credentials
    if (!cli.email || !cli.password) {
      log.error('EMAIL and PASSWORD are required. Set TEST_EMAIL/TEST_PASSWORD in .env or pass --email/--password.');
      process.exitCode = 1; return;
    }

    const result = await loginViaHttp(
      { email: cli.email, password: cli.password },
      { targetUrl: cli.loginUrl, timeoutMs: 60000 },
    );

    try {
      if (result.success) {
        const outputFile = writeLoginOutput(result);
        console.log(`\n✓ HTTP login successful`);
        console.log(`  status:   ${result.status}`);
        console.log(`  output:   ${outputFile}`);
      } else {
        console.error(`\n✗ HTTP login failed: ${result.error || result.message}`);
        process.exitCode = 1; return;
      }
    } finally {
      closeHttpSession(result?.session);
    }
  } catch (err) {
    log.error('Unexpected error during HTTP login');
    log.debug(`Error details: ${err.message}`);
    process.exitCode = 1; return;
  }
})().then(() => process.exit(process.exitCode || 0));
