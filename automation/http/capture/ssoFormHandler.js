/**
 * =============================================================================
 * SSO FORM HANDLER - Shared SSO auto-submit form parser
 * =============================================================================
 * 
 * Reusable utility for parsing and submitting SSO redirect forms.
 * Used by order history, profile data, and other SSO-protected endpoints.
 * 
 * =============================================================================
 */

const { createLogger } = require('../../../logger');
const log = createLogger('sso-form');

/**
 * Parses SSO auto-submit form from HTML.
 * Looks for forms with id="post_form" or containing sessionAlign patterns.
 * 
 * @param {string} html - HTML content to parse
 * @returns {{ action: string|null, fields: Object }} Form action URL and hidden input fields
 */
function parseSsoForm(html) {
  // Try multiple patterns to find form action
  const formActionMatch = 
    html.match(/<form[^>]*id=["']?post_form["']?[^>]*action=["']([^"']+)["']/i) ||
    html.match(/<form[^>]*action=["']([^"']+)["'][^>]*id=["']?post_form["']?/i) ||
    html.match(/<form[^>]*action=["']([^"']+)["']/i);
  
  if (!formActionMatch) {
    return { action: null, fields: {} };
  }
  
  const action = formActionMatch[1].replace(/&amp;/g, '&');
  
  // Extract all hidden inputs using multiple patterns
  const fields = {};
  
  // Pattern 1: name before value
  const inputRegex1 = /<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/gi;
  let match;
  while ((match = inputRegex1.exec(html)) !== null) {
    fields[match[1]] = match[2];
  }
  
  // Pattern 2: value before name
  const inputRegex2 = /<input[^>]*value=["']([^"']*)["'][^>]*name=["']([^"']+)["'][^>]*>/gi;
  while ((match = inputRegex2.exec(html)) !== null) {
    fields[match[2]] = match[1];
  }
  
  return { action, fields };
}

/**
 * Checks if HTML contains an SSO redirect form.
 * @param {string} html - HTML content
 * @returns {boolean}
 */
function hasSsoForm(html) {
  return html.includes('post_form') || 
         html.includes('sessionAlign') ||
         html.includes('login.account.rakuten.com');
}

/**
 * Submits SSO form and follows redirects until reaching final page.
 * @param {Object} client - HTTP client
 * @param {string} html - Initial HTML with SSO form
 * @param {string} currentUrl - Current URL for referer
 * @param {number} timeoutMs - Request timeout
 * @param {number} maxIterations - Maximum form submissions
 * @returns {Promise<{ html: string, url: string }>} Final HTML and URL
 */
async function followSsoRedirects(client, html, currentUrl, timeoutMs, maxIterations = 5) {
  let iterations = maxIterations;
  
  while (iterations-- > 0 && hasSsoForm(html)) {
    const { action, fields } = parseSsoForm(html);
    
    if (!action || Object.keys(fields).length === 0) {
      break;
    }
    
    log.debug(`SSO form action: ${action.substring(0, 60)}...`);
    log.debug(`SSO form fields: ${Object.keys(fields).join(', ')}`);
    
    const response = await client.post(action, new URLSearchParams(fields).toString(), {
      timeout: timeoutMs,
      maxRedirects: 10,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': currentUrl,
      },
    });
    
    html = response.data;
    currentUrl = response.request?.res?.responseUrl || response.config?.url || '';
    log.debug(`SSO redirect - URL: ${currentUrl.substring(0, 80)}...`);
  }
  
  return { html, url: currentUrl };
}

module.exports = {
  parseSsoForm,
  hasSsoForm,
  followSsoRedirects,
};

