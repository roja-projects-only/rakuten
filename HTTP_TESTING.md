# HTTP Checker Implementation - Testing Guide

## ⚠️ IMPORTANT: CURRENT STATUS

**The HTTP checker is currently NON-FUNCTIONAL** due to Rakuten's challenge-response system.

### Technical Details

The login flow requires computing a `cres` (challenge response) value from `mdata` returned by the `/util/gc` endpoint. The `mdata` contains:

```json
{
  "status": 200,
  "body": {
    "mask": "abce",     // hex string
    "key": "e2",        // hex string
    "seed": 3973842396  // integer
  }
}
```

The `cres` is a 16-character alphanumeric string like `08ZXLWGkDgsfbOgc` that must be computed from these values using an algorithm implemented in Rakuten's client-side Elm/JavaScript code.

**What's working:**
- ✅ Cookie/session management
- ✅ Fingerprinting (RAT) data generation
- ✅ Navigation and form submission
- ✅ Challenge token retrieval from `/util/gc`

**What's NOT working:**
- ❌ `cres` computation - The algorithm is proprietary and would require reverse-engineering the minified Elm JS bundle

### To Fix This (Future Work)

1. **Option A**: Decompile and analyze Rakuten's Elm JavaScript bundle to understand the cres algorithm
2. **Option B**: Use a headless browser (Puppeteer) to execute the real JS and extract the computed cres
3. **Option C**: Use browser automation to intercept the cres before submission

### Recommendation

**Continue using Puppeteer (`USE_HTTP_CHECKER=false`)** until the cres algorithm is reverse-engineered.

---

## Quick Start Test

### 1. Capture Real Login Data First (CRITICAL)

Before testing, you MUST capture actual request data from Chrome DevTools:

```bash
# Open Chrome with DevTools
1. Navigate to Rakuten login page
2. Open DevTools (F12) → Network tab
3. Filter: "Fetch/XHR"
4. Perform manual login
5. Find POST requests to /v2/login/start and /v2/login/complete
6. Copy request payload and headers
```

### 2. Update Placeholder Code

Edit `automation/http/httpFlow.js`:
- Replace payload structures in `submitEmailStep()` and `submitPasswordStep()`
- Add actual form fields, tokens, RAT structure from captured data

### 3. Enable HTTP Checker

```bash
# In .env file
USE_HTTP_CHECKER=true
```

### 4. Test Single Credential

```bash
npm start

# In Telegram, send:
.chk test@example.com:password123
```

## Expected Behavior

### If Working:
```
✅ VALID - Login successful
✅ INVALID - Invalid credentials
⚠️ BLOCKED - Captcha/rate limit
❌ ERROR - Request/parsing failed
```

### If Not Working:
```
❌ "Unable to determine login status"
   → Check response parsing in htmlAnalyzer.js

❌ 401 "Invalid credentials" (but creds are correct)
   → Payload structure mismatch
   → Missing required headers/tokens

❌ "BLOCKED" immediately
   → Fingerprinting insufficient
   → Need better RAT/bio data
```

## Debugging

### Enable Debug Logging
```bash
# In .env
LOG_LEVEL=debug
npm start
```

### Compare with Puppeteer
```bash
# Test same credential with both methods
USE_HTTP_CHECKER=false npm start
.chk test@example.com:password123

USE_HTTP_CHECKER=true npm start
.chk test@example.com:password123
```

### Inspect HTTP Requests
Add to `httpClient.js` interceptor:
```javascript
client.interceptors.request.use((config) => {
  console.log('REQUEST:', {
    url: config.url,
    method: config.method,
    headers: config.headers,
    data: config.data,
  });
  return config;
});
```

## Common Issues

### Issue: "Navigation failed"
**Cause**: Can't reach login page
**Fix**: Check TARGET_LOGIN_URL, proxy settings, network connectivity

### Issue: "Email submission failed"
**Cause**: Wrong endpoint or payload structure
**Fix**: Verify `/v2/login/start` endpoint and payload format from DevTools

### Issue: "Password submission failed"
**Cause**: Wrong endpoint, missing token, bad payload
**Fix**: Verify `/v2/login/complete` endpoint and required fields

### Issue: All checks return "INVALID" (even valid creds)
**Cause**: Response parsing incorrect or authentication actually failing
**Fix**: 
1. Compare response structure with Puppeteer
2. Check if cookies are being stored/sent
3. Verify challenge/token generation

### Issue: All checks return "BLOCKED"
**Cause**: Detection by anti-bot systems
**Fix**:
1. Improve fingerprinting (RAT, bio data)
2. Add more realistic delays
3. Use residential proxies
4. Reduce concurrency

## Performance Testing

### Measure Speed Difference

```javascript
// Test script (save as test-performance.js)
const puppeteerChecker = require('./puppeteerChecker');
const httpChecker = require('./httpChecker');

async function test() {
  const creds = { email: 'test@example.com', password: 'password123' };
  
  // Puppeteer
  const t1 = Date.now();
  await puppeteerChecker.checkCredentials(creds.email, creds.password);
  const puppeteerTime = Date.now() - t1;
  
  // HTTP
  const t2 = Date.now();
  await httpChecker.checkCredentials(creds.email, creds.password);
  const httpTime = Date.now() - t2;
  
  console.log(`Puppeteer: ${puppeteerTime}ms`);
  console.log(`HTTP: ${httpTime}ms`);
  console.log(`Speedup: ${(puppeteerTime / httpTime).toFixed(1)}x`);
}

test();
```

### Test Concurrency

```bash
# Low concurrency (safe)
BATCH_CONCURRENCY=5 USE_HTTP_CHECKER=true npm start

# Medium concurrency (moderate risk)
BATCH_CONCURRENCY=20 USE_HTTP_CHECKER=true npm start

# High concurrency (high risk, test carefully)
BATCH_CONCURRENCY=50 USE_HTTP_CHECKER=true npm start
```

## Validation Checklist

Before deploying HTTP checker:

- [ ] Captured real request data from Chrome DevTools
- [ ] Updated payload structures in httpFlow.js
- [ ] Tested with known valid credentials (result: VALID)
- [ ] Tested with known invalid credentials (result: INVALID)
- [ ] Verified data capture works (points/rank extracted)
- [ ] Tested batch processing with small file
- [ ] Compared results with Puppeteer (should match)
- [ ] No immediate BLOCKED statuses
- [ ] Logs show no errors/warnings
- [ ] Response times acceptable (<5s per check)

## Rollback Plan

If HTTP checker doesn't work:

```bash
# Immediately disable
USE_HTTP_CHECKER=false

# Or remove from .env entirely
# The bot will fall back to Puppeteer
```

## Next Steps After Testing

1. **If it works**: Gradually increase concurrency, monitor for blocks
2. **If it doesn't work**: Review captured data, check logs, compare requests
3. **If partially works**: Identify which step fails, fix that specific part
4. **If gets blocked**: Improve fingerprinting, add delays, use better proxies

## Support Resources

- Check logs: `LOG_LEVEL=debug npm start`
- Compare with Chrome DevTools Network tab
- Review [automation/http/README.md](automation/http/README.md)
- Test each step individually (navigate, email, password)
- Verify session cookies are persisting
