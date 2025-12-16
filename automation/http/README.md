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
    └── challengeGenerator.js  # Challenge tokens and POW cres computation
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

## Implementation Status

### ✅ Complete:
- HTTP client with cookie management
- Session lifecycle and recycling
- HTML parsing and analysis
- Data extraction from HTML
- Fingerprinting generators (RAT, bio)
- Drop-in replacement interface
- **cres (Proof-of-Work) computation** - reverse-engineered from r10-challenger.js

### ⚠️ Needs Testing:
- Full login flow end-to-end with real credentials
- RAT data format may need adjustment
- Edge cases and error handling

## cres (Challenge Response) Algorithm

The `cres` is computed using a Proof-of-Work algorithm. The `/util/gc` endpoint returns `mdata`:

```json
{
  "status": 200,
  "body": {
    "mask": "abce",     // Hex prefix the hash must start with
    "key": "e2",        // Prefix for the cres string
    "seed": 3973842396  // Seed for MurmurHash3
  }
}
```

The algorithm:
1. Generate `stringToHash = key + randomSuffix` (16 chars total)
2. Compute `hash = MurmurHash3_x64_128(stringToHash, seed)`
3. Check if `hash.startsWith(mask)`
4. Repeat until condition is met
5. Return `stringToHash` as the `cres`

This POW ensures each cres requires computational work, preventing automated brute-force attacks.

### Key Files
- `challengeGenerator.js` - Contains `computeCresFromMdata()`, `murmurHash3_x64_128()`, `solvePow()`
- Reverse-engineered from `r10-challenger-0.2.1-a6173d7.js`

## Testing

```powershell
# Test with a single credential
$env:USE_HTTP_CHECKER="true"; npm start
# Then send: .chk test@example.com:password123

# Compare with Puppeteer
$env:USE_HTTP_CHECKER="false"; npm start
# Then send same credential

# Enable debug logging
$env:LOG_LEVEL="debug"; $env:USE_HTTP_CHECKER="true"; npm start
```

## Troubleshooting

### "WRONG_VERIFICATION_CODE" Error
- ❌ Previously: cres algorithm was not implemented
- ✅ Now: POW algorithm is implemented, should generate valid cres

### "Unable to determine login status"
- Check if response structure matches expectations in `htmlAnalyzer.js`
- Verify cookies are being set correctly
- Check if redirect chain is followed properly

### "Authentication failed" / 401 errors
- Request payload structure is incorrect
- Missing required headers
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
