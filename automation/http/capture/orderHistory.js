/**
 * =============================================================================
 * ORDER HISTORY - Fetch latest order from purchase history
 * =============================================================================
 * 
 * Handles SSO flow to access order.my.rakuten.co.jp and extract order data.
 * 
 * =============================================================================
 */

const { createLogger } = require('../../../logger');
const { hasSsoForm, followSsoRedirects } = require('./ssoFormHandler');

const log = createLogger('order-history');

const ORDER_HISTORY_URL = 'https://order.my.rakuten.co.jp/purchase-history/order-list?l-id=pc_header_func_ph';

/**
 * Fetches the latest order info from purchase history.
 * Handles SSO flow: order.my.rakuten.co.jp → login.account.rakuten.com → sessionAlign → redirect back
 * @param {Object} client - HTTP client
 * @param {Object} jar - Cookie jar
 * @param {number} timeoutMs - Request timeout
 * @returns {Promise<Object|null>} { date, orderId } or null if no orders
 */
async function fetchLatestOrder(client, jar, timeoutMs) {
  try {
    log.debug('Fetching order history with SSO flow...');
    
    // Step 1: Initial request to order history - will redirect to SSO authorize
    let response = await client.get(ORDER_HISTORY_URL, {
      timeout: timeoutMs,
      maxRedirects: 10,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
      },
    });
    
    let html = response.data;
    let currentUrl = response.request?.res?.responseUrl || response.config?.url || '';
    log.debug(`Step 1 - URL: ${currentUrl.substring(0, 80)}...`);
    
    // Step 2: Handle SSO redirects if present
    if (hasSsoForm(html)) {
      log.debug('Got SSO authorize page, following redirects...');
      const result = await followSsoRedirects(client, html, currentUrl, timeoutMs, 3);
      html = result.html;
      currentUrl = result.url;
    }
    
    // Final check
    log.debug(`Final response length: ${html.length}`);
    
    if (response.status !== 200) {
      log.warn(`Order history returned status ${response.status}`);
      return null;
    }
    
    // Check if we got the order page
    const hasOrderDate = html.includes('注文日');
    const hasOrderNum = html.includes('注文番号');
    log.debug(`Order page check - 注文日: ${hasOrderDate}, 注文番号: ${hasOrderNum}`);
    
    if (!hasOrderDate && !hasOrderNum) {
      const preview = html.substring(0, 500).replace(/\s+/g, ' ');
      log.debug(`Response preview: ${preview}`);
    }
    
    let latestOrderDate = null;
    let latestOrderId = null;
    
    // Extract order date using regex on raw HTML
    // HTML structure: <span>注文日\n<!-- -->\n：</span>\n<span...>2025/12/04(木)</span>
    const datePattern = /注文日[\s\S]*?[：:]<\/span>[\s\S]*?<span[^>]*>(\d{4}\/\d{2}\/\d{2})/;
    const dateMatch = html.match(datePattern);
    if (dateMatch) {
      latestOrderDate = dateMatch[1];
      log.debug(`Date pattern matched: ${latestOrderDate}`);
    } else {
      log.debug('Date pattern did NOT match');
      const idx = html.indexOf('注文日');
      if (idx !== -1) {
        log.debug(`Found 注文日 at index ${idx}, snippet: ${html.substring(idx, idx + 200).replace(/\n/g, '\\n')}`);
      }
    }
    
    // Extract order number using regex
    // HTML structure: <span>注文番号\n<!-- -->\n：</span>\n<span...>263885-20251204-0284242812</span>
    const orderPattern = /注文番号[\s\S]*?[：:]<\/span>[\s\S]*?<span[^>]*>(\d+-\d+-(\d+))<\/span>/;
    const orderMatch = html.match(orderPattern);
    if (orderMatch) {
      latestOrderId = orderMatch[2]; // Get just the order ID part (e.g., 0284242812)
      log.debug(`Order pattern matched: ${orderMatch[1]} -> ID: ${latestOrderId}`);
    } else {
      log.debug('Order pattern did NOT match');
    }
    
    if (latestOrderDate || latestOrderId) {
      log.info(`Latest order - date: ${latestOrderDate}, orderId: ${latestOrderId}`);
      return { date: latestOrderDate, orderId: latestOrderId };
    }
    
    log.info('No orders found in purchase history');
    return null;
  } catch (error) {
    log.warn('Failed to fetch order history:', error.message);
    return null;
  }
}

module.exports = {
  fetchLatestOrder,
  ORDER_HISTORY_URL,
};

