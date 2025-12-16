/**
 * =============================================================================
 * HTML ANALYZER - CHEERIO-BASED HTML PARSING AND OUTCOME DETECTION
 * =============================================================================
 * 
 * Replaces Puppeteer's page.content() and DOM queries with Cheerio parsing.
 * Analyzes HTML responses to determine login outcomes and extract data.
 * 
 * =============================================================================
 */

const cheerio = require('cheerio');
const { createLogger } = require('../../logger');

const log = createLogger('html-analyzer');

/**
 * Detects login outcome from response and HTML content.
 * Similar to resultAnalyzer.js but works with HTTP responses.
 * 
 * @param {Object} response - Axios response object
 * @param {string} [finalUrl] - Final URL after redirects
 * @returns {Object} Outcome object with status and message
 */
function detectOutcome(response, finalUrl = null) {
  try {
    const url = finalUrl || response?.url || response?.config?.url || '';
    const status = response?.status || 0;
    const contentType = response?.headers?.['content-type'] || '';
    const data = response?.data;
    
    log.debug(`[detect] status=${status} url=${url}`);
    log.debug(`[detect] contentType=${contentType}`);
    log.debug(`[detect] data keys=${data ? Object.keys(data).join(', ') : 'null'}`);
    log.debug(`[detect] data=${JSON.stringify(data)?.substring(0, 500)}`);

    // Check for successful authentication - 200 with redirect to rakuten.co.jp + code
    if (status === 200) {
      // Check if response data indicates success (redirect URL in JSON)
      if (data && typeof data === 'object' && data.redirect_uri) {
        // Direct success: redirect to www.rakuten.co.jp with code
        if (data.redirect_uri.includes('www.rakuten.co.jp') && data.redirect_uri.includes('code=')) {
          return {
            status: 'VALID',
            message: 'Login successful - Valid credentials',
            url: data.redirect_uri,
          };
        }
        
        // Intermediate success: redirect to member.id.rakuten.co.jp for session alignment
        // This indicates valid credentials - needs to follow redirect chain
        if (data.redirect_uri.includes('member.id.rakuten.co.jp') && data.payload?.align_token) {
          log.debug('[detect] Session alignment redirect - credentials are VALID');
          return {
            status: 'VALID',
            message: 'Login successful - Valid credentials (session alignment pending)',
            url: data.redirect_uri,
            needsSessionAlign: true,
            alignToken: data.payload.align_token,
          };
        }
      }
      
      // Check final URL pattern
      if (url && url.includes('www.rakuten.co.jp') && url.includes('code=')) {
        return {
          status: 'VALID',
          message: 'Login successful - Valid credentials',
          url,
        };
      }
    }

    // Check for 401 Unauthorized with JSON error
    if (status === 401) {
      const errorMessage = data?.message || 'Invalid Authorization';
      const errorCode = data?.errorCode || 'UNKNOWN';
      log.debug(`[detect] 401 errorCode=${errorCode}`);
      
      return {
        status: 'INVALID',
        message: `Invalid credentials - ${errorCode}: ${errorMessage}`,
      };
    }
    
    // Check for 400 Bad Request (usually means malformed payload)
    if (status === 400) {
      const errorMessage = data?.message || data?.error || 'Bad Request';
      log.debug(`[detect] 400 error=${errorMessage}`);
      
      return {
        status: 'ERROR',
        message: `Request error - ${errorMessage}`,
      };
    }

    // Analyze HTML content if available
    if (contentType.includes('text/html') && data) {
      const htmlContent = typeof data === 'string' 
        ? data 
        : String(data);
      
      const outcome = analyzeHtmlContent(htmlContent, url);
      if (outcome) {
        return outcome;
      }
    }

    // Check final URL pattern for success (fallback)
    if (url && url.includes('www.rakuten.co.jp') && url.includes('code=')) {
      log.debug('[detect] URL-based valid');
      return {
        status: 'VALID',
        message: 'Login successful - Redirected to main site',
        url,
      };
    }

    // Unable to determine - default to ERROR
    log.debug('[detect] fallback ERROR');
    return {
      status: 'ERROR',
      message: 'Unable to determine login status - Please check manually',
      url,
    };
  } catch (error) {
    log.warn('[detect] exception:', error.message);
    return {
      status: 'ERROR',
      message: `Detection error: ${error.message}`,
    };
  }
}

/**
 * Analyzes HTML content for error indicators.
 * @param {string} html - HTML content
 * @param {string} url - Current URL
 * @returns {Object|null} Outcome object or null if no clear indicator
 */
function analyzeHtmlContent(html, url) {
  const contentLower = html.toLowerCase();
  
  // Check for CAPTCHA/challenge indicators
  const blockedIndicators = [
    'captcha',
    'recaptcha',
    'challenge',
    'verify you are human',
    'unusual activity',
    'suspected bot',
  ];
  
  for (const indicator of blockedIndicators) {
    if (contentLower.includes(indicator)) {
      return {
        status: 'BLOCKED',
        message: `Account blocked or verification required - Detected: ${indicator}`,
      };
    }
  }
  
  // Check for invalid credential indicators
  const invalidIndicators = [
    'incorrect',
    'invalid',
    'wrong password',
    'wrong email',
    'authentication failed',
    'ログインできませんでした', // Login failed (Japanese)
    '入力内容に誤りがあります',   // Input error (Japanese)
  ];
  
  for (const indicator of invalidIndicators) {
    if (contentLower.includes(indicator)) {
      return {
        status: 'INVALID',
        message: `Invalid credentials - Found error: ${indicator}`,
      };
    }
  }
  
  return null;
}

/**
 * Extracts form fields from HTML (for CSRF tokens, hidden fields, etc.).
 * @param {string} html - HTML content
 * @param {string} [formSelector] - CSS selector for form (default: first form)
 * @returns {Object} Form fields as key-value pairs
 */
function extractFormFields(html, formSelector = 'form') {
  const $ = cheerio.load(html);
  const form = $(formSelector).first();
  
  if (!form.length) {
    log.warn('No form found in HTML');
    return {};
  }
  
  const fields = {};
  
  // Extract all input fields
  form.find('input').each((i, elem) => {
    const $input = $(elem);
    const name = $input.attr('name');
    const value = $input.attr('value') || '';
    
    if (name) {
      fields[name] = value;
    }
  });
  
  log.debug(`Extracted ${Object.keys(fields).length} form fields`);
  return fields;
}

/**
 * Extracts data from authenticated page (points, membership, etc.).
 * @param {string} html - HTML content
 * @returns {Object} Extracted data
 */
function extractAccountData(html) {
  const $ = cheerio.load(html);
  
  const data = {
    points: 'n/a',
    rank: 'n/a',
    cash: 'n/a',
  };
  
  try {
    // Extract points (look for patterns like "1,234 ポイント" or "1,234 points")
    const pointsPattern = /(\d{1,3}(?:,\d{3})*)\s*(?:ポイント|points?)/i;
    const pointsMatch = html.match(pointsPattern);
    if (pointsMatch) {
      data.points = pointsMatch[1];
      log.debug(`Extracted points: ${data.points}`);
    }
    
    // Extract membership rank
    const rankPatterns = [
      /プラチナ会員/i,
      /ゴールド会員/i,
      /シルバー会員/i,
      /ダイヤモンド会員/i,
      /platinum/i,
      /gold/i,
      /silver/i,
      /diamond/i,
    ];
    
    for (const pattern of rankPatterns) {
      if (pattern.test(html)) {
        data.rank = html.match(pattern)[0];
        log.debug(`Extracted rank: ${data.rank}`);
        break;
      }
    }
  } catch (err) {
    log.warn('Failed to extract account data:', err.message);
  }
  
  return data;
}

/**
 * Checks if response indicates a redirect.
 * @param {Object} response - Axios response
 * @returns {boolean} True if redirect
 */
function isRedirect(response) {
  return response.status >= 300 && response.status < 400;
}

/**
 * Extracts redirect URL from response.
 * @param {Object} response - Axios response
 * @returns {string|null} Redirect URL or null
 */
function getRedirectUrl(response) {
  return response.headers.location || null;
}

module.exports = {
  detectOutcome,
  analyzeHtmlContent,
  extractFormFields,
  extractAccountData,
  isRedirect,
  getRedirectUrl,
};
