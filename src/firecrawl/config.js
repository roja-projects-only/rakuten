// LOCAL-ONLY: not for production services. Used by scripts/firecrawl/ only.
// @ts-check

'use strict';

const crypto = require('crypto');
const { createLogger } = require('../shared/logger');

const log = createLogger('firecrawl');

/**
 * Reads FIRECRAWL_* env vars, validates them, and exports a frozen config object.
 *
 * Call `validateConfig()` explicitly before any SDK call to fail fast with a
 * clear message when FIRECRAWL_API_KEY is missing.
 *
 * @returns {{ apiKey: string, profileName: string, proxy: string, location: { country: string, languages: string[] }, requestDelayMs: number, hash: string }}
 */
function loadConfig() {
  const apiKey = process.env.FIRECRAWL_API_KEY || '';
  const profileName = process.env.FIRECRAWL_PROFILE_NAME || 'rakuten-explorer';
  const proxy = process.env.FIRECRAWL_PROXY || 'enhanced';
  const country = process.env.FIRECRAWL_LOCATION_COUNTRY || 'JP';
  const languagesRaw = process.env.FIRECRAWL_LOCATION_LANGUAGES || 'ja';
  const languages = languagesRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const requestDelayMs = parseInt(process.env.FIRECRAWL_REQUEST_DELAY_MS || '10000', 10);

  const config = {
    apiKey,
    profileName,
    proxy,
    location: { country, languages },
    requestDelayMs: isNaN(requestDelayMs) ? 10000 : requestDelayMs,
    hash: '', // placeholder, replaced below
  };

  // Compute a short hash of the config (minus the hash field itself) for
  // embedding in output metadata.
  const hashable = { ...config };
  delete hashable.hash;
  const hash = crypto.createHash('sha256').update(JSON.stringify(hashable)).digest('hex').slice(0, 8);
  config.hash = hash;

  return Object.freeze(config);
}

const config = loadConfig();

/**
 * Validates that FIRECRAWL_API_KEY is set.
 * Prints a clear error message to stderr and exits the process if missing.
 *
 * Scripts should call this before making any Firecrawl SDK call.
 */
function validateConfig() {
  if (!config.apiKey) {
    log.error('');
    log.error('╔══════════════════════════════════════════════════════════════╗');
    log.error('║  FIRECRAWL_API_KEY is not set.                             ║');
    log.error('║                                                           ║');
    log.error('║  Add your Firecrawl API key to the .env file:             ║');
    log.error('║    FIRECRAWL_API_KEY=your-api-key-here                     ║');
    log.error('║                                                           ║');
    log.error('║  Get a key at https://www.firecrawl.dev                   ║');
    log.error('╚══════════════════════════════════════════════════════════════╝');
    log.error('');
    process.exit(1);
  }
}

module.exports = { config, validateConfig };
