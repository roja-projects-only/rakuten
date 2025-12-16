/**
 * =============================================================================
 * HTTP CHECKER README
 * =============================================================================
 * 
 * This directory contains a complete HTTP-based implementation of the Rakuten
 * credential checker as an alternative to Puppeteer browser automation.
 * 
 * =============================================================================
 */

## Overview

The HTTP checker replicates the Rakuten login flow using pure HTTP requests instead of controlling a headless browser. This approach offers:

### Advantages:
- **10-50x faster** per check (no browser overhead)
- **Higher concurrency** (100+ parallel checks vs ~10 with browsers)
- **Lower resource usage** (minimal CPU/memory vs heavy browser processes)
- **Easier deployment** (no Chrome/Chromium dependencies)

### Disadvantages:
- **Requires exact request replication** (headers, cookies, fingerprinting data)
- **More maintenance** (must update when Rakuten changes API)
- **Higher detection risk** if fingerprinting is incomplete
- **No visual debugging** (can't see what's happening like with screenshots)

## Architecture

```
httpChecker.js              # Main entry point (drop-in replacement for puppeteerChecker.js)
automation/http/
├── httpClient.js           # Axios client with cookie jar and proxy support
├── sessionManager.js       # Session lifecycle management and recycling
├── httpFlow.js             # Login flow implementation (navigate → email → password)
├── htmlAnalyzer.js         # HTML parsing and outcome detection (Cheerio-based)
├── httpDataCapture.js      # Account data extraction from HTML
└── fingerprinting/
    ├── ratGenerator.js     # RAT (Rakuten Analytics Tracking) generator
    ├── bioGenerator.js     # Behavioral biometrics (keystroke/mouse)
    └── challengeGenerator.js  # Challenge tokens and session tokens
```

## Usage

### Enable HTTP Checker

Add to your `.env` file:
```env
USE_HTTP_CHECKER=true
```

The bot will automatically use HTTP checker instead of Puppeteer.

### Switch Back to Puppeteer

```env
USE_HTTP_CHECKER=false
# or remove the line entirely
```

## Current Implementation Status

### ✅ Complete:
- HTTP client with cookie management
- Session lifecycle and recycling
- HTML parsing and analysis
- Data extraction from HTML
- Fingerprinting generators (RAT, bio, challenge)
- Drop-in replacement interface

### ⚠️ Placeholders (Needs Chrome DevTools Data):
- **Exact request payloads** for `/v2/login/start` and `/v2/login/complete`
- **Form field structures** (hidden fields, CSRF tokens)
- **RAT data format** (currently using placeholder structure)
- **Challenge token generation** (currently random, needs actual algorithm)
- **Header requirements** (may need specific headers beyond standard browser headers)

## Next Steps: Capturing Real Request Data

To make this fully functional, you need to capture actual login request data:

### 1. Open Chrome DevTools
```
1. Open Chrome browser
2. Press F12 to open DevTools
3. Go to Network tab
4. Filter by "Fetch/XHR"
```

### 2. Perform Login
```
1. Navigate to the Rakuten login page
2. Enter email and click Next
3. Enter password and click Login
4. Watch Network tab for requests
```

### 3. Capture Critical Requests
Look for these requests and save their details:

#### Request 1: Email Submit
- **URL**: `/v2/login/start` or similar
- **Method**: POST
- **Payload**: Copy entire request body
- **Headers**: Copy all request headers

#### Request 2: Password Submit
- **URL**: `/v2/login/complete`
- **Method**: POST
- **Payload**: Copy entire request body (especially `challenge`, `token`, `rat`, `bio` fields)
- **Headers**: Copy all request headers
- **Response**: Note status codes and any redirect URLs

### 4. Update Code

Replace placeholder payloads in `httpFlow.js`:

```javascript
// In submitEmailStep(), replace:
const payload = {
  user_id: email,
  // ... ADD ACTUAL FIELDS FROM CHROME DEVTOOLS
};

// In submitPasswordStep(), replace:
const payload = {
  user_key: password,
  // ... ADD ACTUAL FIELDS FROM CHROME DEVTOOLS
};
```

## Testing

Once you have real request data:

```bash
# Test with a single credential
USE_HTTP_CHECKER=true npm start
# Then send: .chk test@example.com:password123

# Compare with Puppeteer
USE_HTTP_CHECKER=false npm start
# Then send same credential
```

## Troubleshooting

### "Unable to determine login status"
- Check if response structure matches expectations in `htmlAnalyzer.js`
- Verify cookies are being set correctly
- Check if redirect chain is followed properly

### "Authentication failed" / 401 errors
- Request payload structure is incorrect
- Missing required headers
- Challenge/token generation doesn't match expected format
- Fingerprinting data is incomplete or wrong format

### "BLOCKED" status
- Fingerprinting is insufficient
- Request patterns don't match real browser behavior
- IP/proxy is flagged
- Too many requests too quickly

## Performance Tuning

Adjust concurrency in `.env`:
```env
# For HTTP checker, you can go much higher
BATCH_CONCURRENCY=50  # vs 8 for Puppeteer
```

## Safety Considerations

- **Start with low concurrency** (5-10) and increase gradually
- **Add delays** between requests if getting rate limited
- **Rotate proxies** if checking large batches
- **Monitor for BLOCKED statuses** - if increasing, reduce concurrency

## Fallback Strategy

The bot can automatically use Puppeteer as fallback for BLOCKED cases:

```javascript
// In telegramHandler.js, you could implement:
if (result.status === 'BLOCKED' && USE_HTTP_CHECKER) {
  log.info('HTTP checker blocked, retrying with Puppeteer...');
  result = await puppeteerChecker.checkCredentials(email, password, options);
}
```

## Contributing

When updating the HTTP checker:
1. Always test against Puppeteer implementation first
2. Verify with real Chrome DevTools data
3. Add detailed logging for debugging
4. Update this README with any changes

## Support

For issues or questions:
1. Check logs with `LOG_LEVEL=debug`
2. Compare requests with Chrome DevTools
3. Verify cookie jar contents
4. Test with `USE_HTTP_CHECKER=false` to rule out credential issues
