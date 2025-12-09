# Rakuten Login Flow - CSS Selectors Documentation

**Target URL**: `https://login.account.rakuten.com/sso/authorize?client_id=rakuten_ichiba_top_web&service_id=s245&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fwww.rakuten.co.jp%2F`

**Language Support**: This flow is language-agnostic as it uses ID and name attributes instead of text-based selectors.

---

## Two-Step Login Flow

### **STEP 1: Email/Username Input**

**URL Pattern**: `#/sign_in`

#### Input Field Selectors (in priority order):
1. `#user_id` - **RECOMMENDED (ID selector)**
2. `input[name="username"]` - Name attribute
3. `input[type="text"][name="username"]` - Type + Name combo
4. `[aria-label="Username or email"]` - ARIA label (language-dependent)

**Field Properties**:
- **Tag**: `INPUT`
- **Type**: `text`
- **Name**: `username`
- **ID**: `user_id`
- **ARIA Label**: "Username or email" (changes per language)

#### Next Button Selectors:
Since the button rendering is dynamic (likely shadow DOM or React), use text-based detection or form submission:

**Recommended Approaches**:
1. **Press Enter**: Fill username field and press Enter key
   ```javascript
   await usernameInput.type('test@example.com');
   await usernameInput.press('Enter');
   ```

2. **Button by text content** (language-dependent):
   ```javascript
   await page.evaluate(() => {
     const buttons = Array.from(document.querySelectorAll('button'));
     const nextBtn = buttons.find(b => b.textContent.trim() === 'Next');
     if (nextBtn) nextBtn.click();
   });
   ```

3. **Submit form directly**:
   ```javascript
   await page.evaluate(() => document.querySelector('form').submit());
   ```

**Navigation Wait**:
```javascript
await page.waitForNavigation({ 
  waitUntil: 'networkidle2',
  timeout: 10000 
});
// OR wait for URL change
await page.waitForFunction(() => window.location.hash.includes('/password'));
```

---

### **STEP 2: Password Input**

**URL Pattern**: `#/sign_in/password`

#### Password Field Selectors (in priority order):
1. `#password_current` - **RECOMMENDED (ID selector)**
2. `input[name="password"]` - Name attribute
3. `input[type="password"][name="password"]` - Type + Name combo
4. `[aria-label="Password"]` - ARIA label (language-dependent)

**Field Properties**:
- **Tag**: `INPUT`
- **Type**: `password`
- **Name**: `password`
- **ID**: `password_current`
- **ARIA Label**: "Password" (changes per language)

#### Submit Button Selectors:
Same approach as Step 1 - use Enter key or form submission:

**Recommended Approaches**:
1. **Press Enter**:
   ```javascript
   await passwordInput.type('password123');
   await passwordInput.press('Enter');
   ```

2. **Submit form**:
   ```javascript
   await page.evaluate(() => document.querySelector('form').submit());
   ```

**Navigation Wait**:
```javascript
await page.waitForNavigation({ 
  waitUntil: 'networkidle2',
  timeout: 15000 
});
```

---

## Network Request Endpoints

### **STEP 1: Username Validation**
- **Endpoint**: `POST https://login.account.rakuten.com/v2/login`
- **Purpose**: Validates username/email
- **Response**: Returns status indicating if user exists

### **STEP 2: Login Complete**
- **Endpoint**: `POST https://login.account.rakuten.com/v2/login/complete`
- **Purpose**: Final authentication with password
- **Response Scenarios**:
  - **200 + redirect to** `www.rakuten.co.jp?code=...` → **VALID**
  - **401 + JSON** `{"errorCode": "INVALID_AUTHORIZATION"}` → **INVALID**
  - **Captcha/challenge content** → **BLOCKED**

---

## Outcome Detection Strategy

### **Priority Detection Method**: Network Response Interception
```javascript
page.on('response', async (response) => {
  if (response.url().includes('/v2/login/complete')) {
    const status = response.status();
    
    if (status === 200) {
      // Check redirect URL
      const redirectUrl = await page.url();
      if (redirectUrl.includes('www.rakuten.co.jp') && redirectUrl.includes('code=')) {
        return 'VALID';
      }
    }
    
    if (status === 401) {
      const json = await response.json().catch(() => null);
      if (json?.errorCode === 'INVALID_AUTHORIZATION') {
        return 'INVALID';
      }
    }
  }
});
```

### **Fallback Detection**: Content Analysis
```javascript
const pageContent = await page.content();

// Check for captcha/challenge
if (pageContent.includes('challenge') || pageContent.includes('captcha')) {
  return 'BLOCKED';
}

// Check for error messages
if (pageContent.includes('incorrect') || pageContent.includes('invalid')) {
  return 'INVALID';
}

// Check URL pattern
if (page.url().includes('www.rakuten.co.jp') && page.url().includes('code=')) {
  return 'VALID';
}
```

---

## Language-Independent Selectors Summary

✅ **Safe to use across all languages**:
- `#user_id` (username field)
- `#password_current` (password field)
- `input[name="username"]` (username field)
- `input[name="password"]` (password field)
- Form submission via Enter key
- Network response interception

❌ **Avoid (language-dependent)**:
- Text-based button selectors (e.g., "Next", "Sign in")
- ARIA labels (e.g., "Username or email", "Password")
- Error message text matching

---

## Implementation Example

```javascript
async function rakutenLogin(page, email, password) {
  // Navigate to login page
  await page.goto('https://login.account.rakuten.com/sso/authorize?client_id=rakuten_ichiba_top_web&service_id=s245&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fwww.rakuten.co.jp%2F', {
    waitUntil: 'networkidle2'
  });
  
  // STEP 1: Enter username
  await page.waitForSelector('#user_id', { timeout: 10000 });
  await page.type('#user_id', email);
  await page.keyboard.press('Enter');
  
  // Wait for password screen
  await page.waitForFunction(() => window.location.hash.includes('/password'), {
    timeout: 10000
  });
  
  // STEP 2: Enter password
  await page.waitForSelector('#password_current', { timeout: 10000 });
  await page.type('#password_current', password);
  
  // Set up response listener BEFORE submitting
  let outcome = null;
  page.on('response', async (response) => {
    if (response.url().includes('/v2/login/complete')) {
      const status = response.status();
      if (status === 200) {
        outcome = 'VALID';
      } else if (status === 401) {
        outcome = 'INVALID';
      }
    }
  });
  
  // Submit password
  await page.keyboard.press('Enter');
  
  // Wait for navigation or outcome
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
    new Promise(resolve => setTimeout(resolve, 5000))
  ]);
  
  return outcome || 'ERROR';
}
```

---

## Notes
- **Shadow DOM**: If buttons are in Shadow DOM, use `page.evaluate()` to access them
- **Incognito Mode**: Always use incognito context to prevent cookie bleed between checks
- **Timeout**: Recommended 60s total timeout for complete flow
- **Screenshots**: Capture on non-VALID outcomes for debugging
- **Rate Limiting**: Rakuten may implement rate limiting - add delays between checks if needed

**Last Updated**: December 9, 2025 (Chrome DevTools MCP inspection)
