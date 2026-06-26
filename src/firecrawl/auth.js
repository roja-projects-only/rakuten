// LOCAL-ONLY: not for production services.
// @ts-check

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { getClient } = require('./client');
const { config } = require('./config');
const { createLogger } = require('../shared/logger');

const log = createLogger('firecrawl:auth');

// ── Private helpers ──────────────────────────────────────────────────

/**
 * Build a natural-language prompt for the Firecrawl interact API to fill
 * the login form with the given credentials.
 *
 * SECURITY: Do not log the return value — contains plaintext password.
 *
 * @param {{ email: string, password: string }} credentials
 * @returns {string}
 */
function buildLoginPrompt(credentials) {
  // SECURITY: Do not log the return value — contains plaintext password
  return `Fill the email/username field with: ${credentials.email}. Then fill the password field with: ${credentials.password}. Then click the submit or login button.`;
}

/**
 * Writes profile metadata to data/firecrawl/profiles/{profileName}.json.
 *
 * This is local-only metadata (Firecrawl stores the actual browser session
 * server-side). Used by Phase 4 (scrape-authed.js) to resume a session.
 *
 * @param {string} profileName
 * @param {string} scrapeId
 * @param {string} loginUrl
 */
function saveProfileMetadata(profileName, scrapeId, loginUrl) {
  const dir = path.resolve(__dirname, '..', '..', 'data', 'firecrawl', 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${profileName}.json`);

  const data = {
    profileName,
    scrapeId,
    loginUrl,
    savedAt: new Date().toISOString(),
    configHash: config.hash,
  };

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  log.info(`Profile metadata saved to ${filePath}`);
}

/**
 * Writes the login result to data/firecrawl/login-{timestamp}.json with
 * embedded metadata.
 *
 * @param {{ scrapeId: string|null, loginUrl: string, profileName: string, success: boolean, error?: string }} result
 * @returns {string} The file path written to.
 */
function writeLoginOutput(result) {
  const ts = new Date();
  const fileSafeTs = ts.toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve(__dirname, '..', '..', 'data', 'firecrawl');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `login-${fileSafeTs}.json`);

  const output = {
    metadata: {
      timestamp: ts.toISOString(),
      configHash: config.hash,
      profileName: config.profileName,
      script: 'login',
    },
    ...result,
  };

  fs.writeFileSync(filePath, JSON.stringify(output, null, 2), 'utf-8');
  log.info(`Login output saved to ${filePath}`);

  return filePath;
}

// ── Exported ─────────────────────────────────────────────────────────

/**
 * Loads a previously-saved profile metadata file.
 *
 * @param {string} profileName
 * @returns {object|null}
 */
function loadProfileMetadata(profileName) {
  const filePath = path.resolve(
    __dirname, '..', '..', 'data', 'firecrawl', 'profiles', `${profileName}.json`,
  );
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Logs into the given loginUrl by:
 *   1. Scraping the login page (no formats — saves credits)
 *   2. Filling credentials via interact (natural language prompt or raw code)
 *   3. Detecting / pausing for 2FA (optional)
 *   4. Waiting for login redirect
 *   5. Stopping the interaction session (saves profile server-side)
 *   6. Writing profile metadata + login output JSON
 *
 * @param {string} loginUrl - The URL of the login page.
 * @param {{ email: string, password: string }} credentials
 * @param {object} [options]
 * @param {boolean} [options.no2fa=false] - Skip 2FA detection and pause entirely.
 * @param {boolean} [options.force2faPause=false] - Skip AI detection, pause unconditionally.
 * @param {string|null} [options.codeFile=null] - Path to raw Playwright code file (alternative to natural language prompt).
 * @param {number} [options.timeout=60000] - Timeout for the initial scrape (ms).
 * @returns {Promise<{ scrapeId: string|null, loginUrl: string, profileName: string, success: boolean, error?: string, outputFile?: string }>}
 */
async function loginAndPersist(loginUrl, credentials, options = {}) {
  const { no2fa = false, force2faPause = false, codeFile = null, timeout = 60000 } = options;

  /** @type {string|null} */
  let scrapeId = null;
  /** @type {Error|null} */
  let error = null;
  /** @type {string|undefined} */
  let outputFile;

  try {
    // ── Step 1: Scrape login page (formats: [] — saves credits) ───
    const result = await getClient().scrape(loginUrl, {
      profile: { name: config.profileName, saveChanges: true },
      location: config.location,
      proxy: config.proxy,
      onlyMainContent: false,
      formats: [],
      timeout,
    });

    // ── Step 2: Extract scrapeId ──────────────────────────────────
    scrapeId = result?.metadata?.scrapeId;
    if (!scrapeId) {
      throw new Error('No scrapeId returned from login page scrape');
    }

    // ── Step 3: Log session start ──────────────────────────────────
    log.info(`Login session started: scrapeId=${scrapeId}, profile=${config.profileName}`);

    // ── Step 4: Fill credentials ───────────────────────────────────
    if (codeFile) {
      const contents = fs.readFileSync(codeFile, 'utf-8');
      const fillResult = await getClient().interact(scrapeId, { code: contents, timeout: 30000 });
      if (!fillResult || fillResult.success === false) {
        throw new Error(`Credential fill (code) failed: ${fillResult?.error || 'unknown'}`);
      }
    } else {
      const fillResult = await getClient().interact(scrapeId, { prompt: buildLoginPrompt(credentials), timeout: 30000 });
      if (!fillResult || fillResult.success === false) {
        throw new Error(`Credential fill (prompt) failed: ${fillResult?.error || 'unknown'}`);
      }
    }

    // ── Step 5: 2FA handling (unless opted out) ────────────────────
    if (!no2fa) {
      let twoFactorDetected = force2faPause;

      if (!force2faPause) {
        const checkResult = await getClient().interact(scrapeId, {
          prompt: 'Check if a 2FA/OTP challenge appeared on the page. Report what you see.',
          timeout: 15000,
        });

        // Extract text from specific response fields (avoid over-broad JSON.stringify)
        const responseText = checkResult?.output || checkResult?.result || checkResult?.stdout || '';
        twoFactorDetected = /2fa|otp|two[ -]?factor|verification code|authenticator|multi[ -]?factor/i.test(responseText);
      }

      if (twoFactorDetected) {
        console.log('\n\u26a0 2FA challenge detected. Enter the 2FA/OTP code from your authenticator, or press Enter to skip:');

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const fiveMin = 5 * 60 * 1000;

        const code = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            log.warn('2FA pause timeout (5 min) reached. Continuing without 2FA code...');
            rl.close();
            resolve('');
          }, fiveMin);

          rl.question('  2FA code: ', (answer) => {
            clearTimeout(timer);
            rl.close();
            resolve(answer.trim());
          });
        });

        if (code) {
          // Fill the 2FA code via interact and submit
          const twoFaResult = await getClient().interact(scrapeId, {
            prompt: `Fill the 2FA/OTP verification code input field with: ${code}. Then click the submit or verify button. Wait for the page to settle.`,
            timeout: 30000,
          });
          if (!twoFaResult || twoFaResult.success === false) {
            log.warn(`2FA code fill may have failed: ${twoFaResult?.error || 'unknown'}`);
          }
        } else {
          // No code entered — wait for page to settle (user may have handled externally)
          await getClient().interact(scrapeId, {
            prompt: 'Wait for the page to settle. Report the current URL.',
            timeout: 30000,
          });
        }
      }
    }

    // ── Step 6: Wait for login redirect ────────────────────────────
    const redirectResult = await getClient().interact(scrapeId, {
      prompt: 'Wait for the login redirect to complete. Report the current URL and whether login appears successful.',
      timeout: 30000,
    });
    if (!redirectResult || redirectResult.success === false) {
      log.warn(`Redirect wait interact failed: ${redirectResult?.error || 'unknown'}`);
    }
  } catch (err) {
    error = /** @type {Error} */ (err);
    log.error('Login flow failed');
    log.debug(`Login flow error details: ${err.message}`);
    if (err.stack) log.debug(err.stack);
  } finally {
    if (scrapeId) {
      try {
        const stopResult = await getClient().stopInteraction(scrapeId);
        if (stopResult && stopResult.success === false) {
          log.warn('stopInteraction reported failure');
        }
      } catch (e) {
        log.warn(`stopInteraction failed: ${e.message}`);
      }
    }
  }

  // After finally: save profile metadata and write output (only on success)
  if (!error && scrapeId) {
    saveProfileMetadata(config.profileName, scrapeId, loginUrl);
    outputFile = writeLoginOutput({
      scrapeId,
      loginUrl,
      profileName: config.profileName,
      success: true,
    });
  }

  return {
    scrapeId,
    loginUrl,
    profileName: config.profileName,
    success: !error,
    error: error?.message,
    ...(outputFile ? { outputFile } : {}),
  };
}

module.exports = { loginAndPersist, loadProfileMetadata };
