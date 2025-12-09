/**
 * =============================================================================
 * RAKUTEN LOGIN FLOW - PUPPETEER AUTOMATION ENGINE
 * =============================================================================
 * 
 * This module handles automated credential checking for Rakuten accounts using
 * Puppeteer browser automation with headless Chrome.
 * 
 * ARCHITECTURE OVERVIEW:
 * ----------------------
 * Login Flow: Two-step authentication process
 *   Step 1: Email/Username submission
 *   Step 2: Password submission with validation
 * 
 * Detection Strategy: Network response interception
 *   - Monitors API endpoints for authentication responses
 *   - Analyzes HTTP status codes (200 = valid, 401 = invalid)
 *   - Validates successful redirect to main site
 * 
 * =============================================================================
 * RAKUTEN LOGIN ENDPOINTS & FLOW
 * =============================================================================
 * 
 * LOGIN URL:
 *   https://login.account.rakuten.com/sso/authorize
 *   Query Parameters:
 *     - client_id=rakuten_ichiba_top_web
 *     - service_id=s245
 *     - response_type=code
 *     - scope=openid
 *     - redirect_uri=https://www.rakuten.co.jp/
 *   Hash Fragment: #/sign_in
 * 
 * TWO-STEP AUTHENTICATION FLOW:
 * ------------------------------
 * 
 * STEP 1: Email/Username Submission
 * ----------------------------------
 * API Endpoint: POST https://login.account.rakuten.com/v2/login/start
 * 
 * Page Elements:
 *   - Email Input: textbox[aria-label="Username or email"]
 *   - Next Button: button containing text "Next"
 * 
 * Response Behavior:
 *   - Status: 200 OK (for both valid and invalid emails)
 *   - Action: Navigates to password screen
 *   - URL Change: #/sign_in → #/sign_in/password
 * 
 * STEP 2: Password Submission & Validation
 * -----------------------------------------
 * API Endpoint: POST https://login.account.rakuten.com/v2/login/complete
 * 
 * Page Elements:
 *   - Password Input: textbox[aria-label="Password"]
 *   - Next Button: button containing text "Next"
 * 
 * VALID LOGIN RESPONSE:
 * ---------------------
 * HTTP Status: 200 OK
 * 
 * Response Headers:
 *   - Set-Cookie: OSSO=<session_token>; Secure; HttpOnly; SameSite=Lax
 *   - Set-Cookie: OSAT=<access_token>; Secure; HttpOnly; SameSite=Lax
 *   - Set-Cookie: ODID=<device_id>; Secure; HttpOnly; SameSite=None
 * 
 * Session Tokens:
 *   - OSSO: OAuth session token (valid for ~90 days)
 *   - OSAT: OAuth access token (shorter lifespan)
 *   - ODID: Device identifier for tracking
 * 
 * Success Indicators:
 *   1. HTTP 200 status from /v2/login/complete
 *   2. Redirect to: https://www.rakuten.co.jp/?code=[AUTH_CODE]
 *   3. Authorization code present in URL
 * 
 * Detection Logic:
 *   - Monitor response status === 200
 *   - Wait for navigation to www.rakuten.co.jp
 *   - Verify URL contains 'code=' parameter
 *   - Confirm cookies are set (OSSO, OSAT)
 * 
 * INVALID LOGIN RESPONSE:
 * -----------------------
 * HTTP Status: 401 Unauthorized
 * 
 * Response Body (JSON):
 *   {
 *     "errorCode": "INVALID_AUTHORIZATION",
 *     "message": "Invalid Authorization"
 *   }
 * 
 * Page Behavior:
 *   - Remains on password screen
 *   - Error message displayed: "Username and/or password are incorrect. Please try again."
 *   - No redirect occurs
 *   - No session cookies set
 * 
 * Detection Logic:
 *   - Monitor response status === 401
 *   - Parse JSON body for errorCode
 *   - Check for error message in DOM
 *   - URL stays at #/sign_in/password
 * 
 * BLOCKED/CAPTCHA DETECTION:
 * --------------------------
 * Indicators:
 *   - Page content contains: "captcha", "recaptcha", "challenge"
 *   - Additional verification step required
 *   - Unusual delay in response
 * 
 * Status: BLOCKED
 * Action: Report to user, recommend manual verification
 * 
 * ERROR HANDLING:
 * ---------------
 * Timeout:
 *   - Default: 60 seconds per operation
 *   - Configurable via TIMEOUT_MS environment variable
 * 
 * Navigation Failures:
 *   - Network errors
 *   - Page load timeouts
 *   - Element not found
 * 
 * Browser Crashes:
 *   - Automatic cleanup in finally block
 *   - Always closes browser instance
 * 
 * =============================================================================
 * SECURITY & PRIVACY CONSIDERATIONS
 * =============================================================================
 * 
 * Incognito Mode:
 *   - Each check runs in isolated incognito context
 *   - No cookie persistence between checks
 *   - No browsing history stored
 * 
 * Headless Browser:
 *   - Runs Chrome without GUI (--headless=new)
 *   - Minimal resource footprint
 *   - Faster execution
 * 
 * Screenshot Capture:
 *   - Optional evidence collection
 *   - Saved to screenshots/ directory
 *   - Named: {status}-{timestamp}.png
 *   - Contains timestamp: YYYYMMDD-HHMMSS
 * 
 * Rate Limiting Recommendations:
 *   - Implement delays between checks (not in this module)
 *   - Rotate proxy servers if available
 *   - Monitor for account lockouts
 * 
 * =============================================================================
 * IMPLEMENTATION DETAILS
 * =============================================================================
 * 
 * Dependencies:
 *   - puppeteer: Browser automation
 *   - fs/promises: Screenshot file operations
 * 
 * Browser Configuration:
 *   - User Agent: Standard Chrome UA
 *   - Viewport: 1920x1080 (desktop)
 *   - Launch Args:
 *       --no-sandbox          (Linux container compatibility)
 *       --disable-setuid-sandbox
 *       --disable-dev-shm-usage (prevent /dev/shm crashes)
 * 
 * Typing Simulation:
 *   - Delay: 50ms between keystrokes (human-like)
 *   - Prevents bot detection
 *   - Mimics natural typing pattern
 * 
 * Wait Strategy:
 *   - Element waits: waitForSelector with timeout
 *   - Navigation waits: waitForNavigation with networkidle0
 *   - Response waits: waitForResponse for specific endpoints
 * 
 * =============================================================================
 */

const puppeteer = require('puppeteer');
const UserAgent = require('user-agents');
const fs = require('fs').promises;
const path = require('path');

/**
 * Main credential checking function.
 * 
 * Workflow:
 *   1. Launch headless Chrome browser
 *   2. Create incognito context (isolated session)
 *   3. Navigate to Rakuten login page
 *   4. Fill email/username field
 *   5. Click first "Next" button
 *   6. Wait for password screen
 *   7. Fill password field
 *   8. Click second "Next" button
 *   9. Intercept /v2/login/complete response
 *   10. Analyze status code and response body
 *   11. Detect outcome (VALID/INVALID/BLOCKED/ERROR)
 *   12. Capture screenshot if needed
 *   13. Clean up browser resources
 * 
 * @param {string} email - User email or username
 * @param {string} password - User password
 * @param {Object} options - Configuration options
 * @param {string} options.targetUrl - Rakuten login URL
 * @param {number} [options.timeoutMs=60000] - Operation timeout in milliseconds
 * @param {string} [options.proxy] - Proxy server URL (optional)
 * @param {boolean} [options.screenshotOn=false] - Whether to capture screenshots
 * @returns {Promise<Object>} Result object with status and message
 *   - status: 'VALID' | 'INVALID' | 'BLOCKED' | 'ERROR'
 *   - message: Detailed status message
 *   - screenshot: Path to screenshot file (if captured)
 */
async function checkCredentials(email, password, options = {}) {
  const {
    targetUrl,
    timeoutMs = 60000,
    proxy = null,
    screenshotOn = false,
  } = options;

  let browser = null;
  let screenshotPath = null;

  try {
    // STEP 1: Launch Browser
    // ----------------------
    console.log('🌐 Launching headless browser...');
    const launchOptions = buildLaunchOptions(proxy);
    browser = await puppeteer.launch(launchOptions);

    // STEP 2: Create Incognito Context
    // ---------------------------------
    // Ensures no cookie bleed between checks
    console.log('🔒 Creating incognito context...');
    const context = await browser.createBrowserContext();
    const page = await context.newPage();

    // Set viewport to standard desktop resolution
    await page.setViewport({ width: 1920, height: 1080 });

    // Set random user agent to avoid detection
    const userAgent = new UserAgent();
    await page.setUserAgent(userAgent.toString());
    console.log(`🎭 Using User-Agent: ${userAgent.data.userAgent}`);

    // STEP 3: Navigate to Login Page
    // -------------------------------
    console.log(`📍 Navigating to: ${targetUrl}`);
    await page.goto(targetUrl, {
      waitUntil: 'networkidle0',
      timeout: timeoutMs,
    });

    console.log('✓ Login page loaded');

    // STEP 4: Fill Email/Username (First Step)
    // -----------------------------------------
    console.log('📧 Entering email/username...');
    const emailSelector = 'input[type="email"], input[name*="user"], input[name*="email"], input[aria-label*="Username"], input[aria-label*="email"]';
    await page.waitForSelector(emailSelector, { timeout: timeoutMs });
    await page.type(emailSelector, email, { delay: 50 }); // Human-like typing

    console.log('✓ Email entered');

    // STEP 5: Click First "Next" Button
    // ----------------------------------
    console.log('🔘 Clicking first Next button...');
    const firstNextButton = await findButton(page, 'Next');
    if (!firstNextButton) {
      throw new Error('First Next button not found');
    }
    await firstNextButton.click();

    // Wait for navigation to password screen
    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: timeoutMs });
    console.log('✓ Navigated to password screen');

    // STEP 6: Fill Password (Second Step)
    // ------------------------------------
    console.log('🔑 Entering password...');
    const passwordSelector = 'input[type="password"], input[name*="password"], input[aria-label*="Password"]';
    await page.waitForSelector(passwordSelector, { timeout: timeoutMs });
    await page.type(passwordSelector, password, { delay: 50 });

    console.log('✓ Password entered');

    // STEP 7: Setup Response Interception
    // ------------------------------------
    // This is critical for detecting VALID vs INVALID
    console.log('👂 Setting up response listener...');
    let loginCompleteResponse = null;

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/v2/login/complete')) {
        loginCompleteResponse = {
          status: response.status(),
          statusText: response.statusText(),
          url: url,
        };

        // Try to capture response body
        try {
          const contentType = response.headers()['content-type'];
          if (contentType && contentType.includes('application/json')) {
            loginCompleteResponse.body = await response.json();
          }
        } catch (err) {
          console.warn('Could not parse response body:', err.message);
        }
      }
    });

    // STEP 8: Click Second "Next" Button (Submit Login)
    // --------------------------------------------------
    console.log('🔘 Clicking second Next button (submitting login)...');
    const secondNextButton = await findButton(page, 'Next');
    if (!secondNextButton) {
      throw new Error('Second Next button not found');
    }

    // Click and wait for response
    await Promise.all([
      secondNextButton.click(),
      page.waitForTimeout(3000), // Give time for response
    ]);

    console.log('✓ Login submitted');

    // STEP 9: Analyze Response & Detect Outcome
    // ------------------------------------------
    console.log('🔍 Analyzing login response...');
    const outcome = await detectOutcome(page, loginCompleteResponse);

    console.log(`📊 Result: ${outcome.status} - ${outcome.message}`);

    // STEP 10: Screenshot Capture (Optional)
    // ---------------------------------------
    if (screenshotOn || outcome.status !== 'VALID') {
      screenshotPath = await captureScreenshot(page, outcome.status);
      outcome.screenshot = screenshotPath;
    }

    return outcome;

  } catch (error) {
    // ERROR HANDLING
    // --------------
    console.error('❌ Error during credential check:', error.message);

    // Capture error screenshot
    if (browser && screenshotOn) {
      try {
        const pages = await browser.pages();
        if (pages.length > 0) {
          screenshotPath = await captureScreenshot(pages[0], 'ERROR');
        }
      } catch (screenshotErr) {
        console.warn('Could not capture error screenshot:', screenshotErr.message);
      }
    }

    return {
      status: 'ERROR',
      message: `Automation error: ${error.message}`,
      screenshot: screenshotPath,
    };

  } finally {
    // CLEANUP: Always close browser
    // ------------------------------
    if (browser) {
      console.log('🧹 Closing browser...');
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Detects login outcome based on response analysis.
 * 
 * Detection Strategy:
 *   1. Check if response was captured
 *   2. Analyze HTTP status code
 *   3. Parse response body
 *   4. Check for page URL changes
 *   5. Scan page content for indicators
 * 
 * Priority Order:
 *   1. BLOCKED (captcha/challenge detected)
 *   2. INVALID (401 status or error message)
 *   3. VALID (200 status + redirect)
 *   4. ERROR (unexpected state)
 * 
 * @param {Object} page - Puppeteer page instance
 * @param {Object} response - Captured login response
 * @returns {Promise<Object>} Outcome with status and message
 */
async function detectOutcome(page, response) {
  try {
    const currentUrl = page.url();
    const pageContent = await page.content().catch(() => '');

    // CHECK 1: Response Analysis
    // --------------------------
    if (response) {
      console.log(`  Response Status: ${response.status}`);
      console.log(`  Current URL: ${currentUrl}`);

      // VALID Login Detection
      // ---------------------
      if (response.status === 200) {
        // Wait a bit for redirect
        await page.waitForTimeout(2000);
        const finalUrl = page.url();

        // Check if redirected to main site with auth code
        if (finalUrl.includes('www.rakuten.co.jp') && finalUrl.includes('code=')) {
          return {
            status: 'VALID',
            message: 'Login successful - Valid credentials',
            url: finalUrl,
          };
        }
      }

      // INVALID Login Detection
      // -----------------------
      if (response.status === 401) {
        const errorMessage = response.body?.message || 'Invalid Authorization';
        const errorCode = response.body?.errorCode || 'UNKNOWN';

        return {
          status: 'INVALID',
          message: `Invalid credentials - ${errorCode}: ${errorMessage}`,
        };
      }
    }

    // CHECK 2: Page Content Analysis
    // -------------------------------
    const contentLower = pageContent.toLowerCase();

    // BLOCKED Detection (Captcha/Challenge)
    // --------------------------------------
    const blockedIndicators = [
      'captcha',
      'recaptcha',
      'challenge',
      'verify you are human',
      'unusual activity',
    ];

    for (const indicator of blockedIndicators) {
      if (contentLower.includes(indicator)) {
        return {
          status: 'BLOCKED',
          message: `Account blocked or verification required - Detected: ${indicator}`,
        };
      }
    }

    // INVALID Detection (Error Messages in DOM)
    // ------------------------------------------
    const invalidIndicators = [
      'incorrect',
      'invalid',
      'wrong password',
      'wrong email',
      'authentication failed',
    ];

    for (const indicator of invalidIndicators) {
      if (contentLower.includes(indicator)) {
        return {
          status: 'INVALID',
          message: `Invalid credentials - Found error: ${indicator}`,
        };
      }
    }

    // CHECK 3: URL-Based Detection
    // -----------------------------
    if (currentUrl.includes('www.rakuten.co.jp') && currentUrl.includes('code=')) {
      return {
        status: 'VALID',
        message: 'Login successful - Redirected to main site',
        url: currentUrl,
      };
    }

    // FALLBACK: Uncertain Outcome
    // ----------------------------
    return {
      status: 'ERROR',
      message: 'Unable to determine login status - Please check manually',
      url: currentUrl,
    };

  } catch (error) {
    return {
      status: 'ERROR',
      message: `Detection error: ${error.message}`,
    };
  }
}

/**
 * Finds and returns a button element by text content.
 * 
 * Strategy:
 *   1. Search for <button> elements
 *   2. Filter by text content (case-insensitive)
 *   3. Return first match
 * 
 * @param {Object} page - Puppeteer page instance
 * @param {string} buttonText - Text to search for
 * @returns {Promise<Object|null>} Button element or null
 */
async function findButton(page, buttonText) {
  try {
    const button = await page.evaluateHandle((text) => {
      const buttons = Array.from(document.querySelectorAll('button'));
      return buttons.find(btn =>
        btn.textContent.trim().toLowerCase().includes(text.toLowerCase())
      );
    }, buttonText);

    const element = button.asElement();
    return element;
  } catch (error) {
    console.warn(`Button with text "${buttonText}" not found:`, error.message);
    return null;
  }
}

/**
 * Captures and saves a screenshot.
 * 
 * Naming Convention:
 *   {status}-{timestamp}.png
 *   Example: VALID-20251209-143022.png
 * 
 * Directory Structure:
 *   screenshots/
 *     ├── VALID-*.png
 *     ├── INVALID-*.png
 *     ├── BLOCKED-*.png
 *     └── ERROR-*.png
 * 
 * @param {Object} page - Puppeteer page instance
 * @param {string} status - Outcome status for filename
 * @returns {Promise<string>} Path to saved screenshot
 */
async function captureScreenshot(page, status) {
  try {
    const screenshotDir = path.join(process.cwd(), 'screenshots');

    // Ensure directory exists
    await fs.mkdir(screenshotDir, { recursive: true });

    // Generate filename with timestamp
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+/, '')
      .replace('T', '-');
    const filename = `${status}-${timestamp}.png`;
    const filepath = path.join(screenshotDir, filename);

    // Capture full page screenshot
    await page.screenshot({
      path: filepath,
      fullPage: true,
    });

    console.log(`📸 Screenshot saved: ${filepath}`);
    return filepath;

  } catch (error) {
    console.warn('Failed to capture screenshot:', error.message);
    return null;
  }
}

/**
 * Builds Puppeteer launch options.
 * 
 * Configuration:
 *   - Headless: New headless mode (faster, more stable)
 *   - Sandbox: Disabled for container compatibility
 *   - DevShm: Disabled to prevent memory issues
 *   - Proxy: Optional proxy server support
 * 
 * @param {string|null} proxy - Proxy server URL (optional)
 * @returns {Object} Puppeteer launch options
 */
function buildLaunchOptions(proxy) {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ];

  if (proxy) {
    args.push(`--proxy-server=${proxy}`);
  }

  return {
    headless: 'new', // Use new headless mode
    args: args,
  };
}

module.exports = { checkCredentials };
