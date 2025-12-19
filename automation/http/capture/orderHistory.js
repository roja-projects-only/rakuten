/**
 * =============================================================================
 * ORDER HISTORY - Fetch latest order from purchase history
 * =============================================================================
 * 
 * Handles SSO flow to access order.my.rakuten.co.jp and extract order data.
 * Uses a 3-step SSO process specific to the order history page.
 * 
 * =============================================================================
 */

const { createLogger } = require('../../../logger');

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
    
    // Step 2: If we got SSO authorize page with auto-submit form, handle it manually
    // The page contains: <form id="post_form" action="..." method="POST">...<input name="..." value="...">
    if (html.includes('post_form') || html.includes('login.account.rakuten.com')) {
      log.debug('Got SSO authorize page, parsing auto-submit form...');
      
      // Parse form action and inputs
      const formActionMatch = html.match(/<form[^>]*id=["']?post_form["']?[^>]*action=["']([^"']+)["']/i) ||
                              html.match(/<form[^>]*action=["']([^"']+)["'][^>]*id=["']?post_form["']?/i);
      
      if (formActionMatch) {
        const formAction = formActionMatch[1].replace(/&amp;/g, '&');
        log.debug(`Form action: ${formAction.substring(0, 80)}...`);
        
        // Extract all hidden inputs
        const formData = {};
        const inputRegex = /<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/gi;
        const inputRegex2 = /<input[^>]*value=["']([^"']*)["'][^>]*name=["']([^"']+)["'][^>]*>/gi;
        
        let match;
        while ((match = inputRegex.exec(html)) !== null) {
          formData[match[1]] = match[2];
        }
        while ((match = inputRegex2.exec(html)) !== null) {
          formData[match[2]] = match[1];
        }
        
        log.debug(`Form fields: ${Object.keys(formData).join(', ')}`);
        
        // Submit the form (this goes to sessionAlign)
        if (Object.keys(formData).length > 0) {
          response = await client.post(formAction, new URLSearchParams(formData).toString(), {
            timeout: timeoutMs,
            maxRedirects: 10,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Origin': 'https://login.account.rakuten.com',
              'Referer': currentUrl,
            },
          });
          
          html = response.data;
          currentUrl = response.request?.res?.responseUrl || response.config?.url || '';
          log.debug(`Step 2 (form submit) - URL: ${currentUrl.substring(0, 80)}...`);
          
          // Step 3: Check if we need to handle another form (redirect back to order history)
          if (html.includes('post_form') || html.includes('purchasehistoryapi/redirect')) {
            const formActionMatch2 = html.match(/<form[^>]*action=["']([^"']+)["']/i);
            if (formActionMatch2) {
              const formAction2 = formActionMatch2[1].replace(/&amp;/g, '&');
              log.debug(`Second form action: ${formAction2.substring(0, 80)}...`);
              
              const formData2 = {};
              const inputRegex3 = /<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/gi;
              while ((match = inputRegex3.exec(html)) !== null) {
                formData2[match[1]] = match[2];
              }
              
              if (Object.keys(formData2).length > 0) {
                response = await client.post(formAction2, new URLSearchParams(formData2).toString(), {
                  timeout: timeoutMs,
                  maxRedirects: 10,
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                  },
                });
                
                html = response.data;
                currentUrl = response.request?.res?.responseUrl || response.config?.url || '';
                log.debug(`Step 3 (second form) - URL: ${currentUrl.substring(0, 80)}...`);
              }
            }
          }
        }
      }
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
    // The colon ： is full-width Japanese colon (U+FF1A)
    const datePattern = /注文日[\s\S]*?[：:]<\/span>[\s\S]*?<span[^>]*>(\d{4}\/\d{2}\/\d{2})/;
    const dateMatch = html.match(datePattern);
    if (dateMatch) {
      latestOrderDate = dateMatch[1];
      log.debug(`Date pattern matched: ${latestOrderDate}`);
    } else {
      log.debug('Date pattern did NOT match');
      // Debug: Find and log the area around 注文日
      const idx = html.indexOf('注文日');
      if (idx !== -1) {
        log.debug(`Found 注文日 at index ${idx}, snippet: ${html.substring(idx, idx + 200).replace(/\n/g, '\\n')}`);
      }
    }
    
    // Extract order number using regex
    // HTML structure: <span>注文番号\n<!-- -->\n：</span>\n<span...>431906-20251214-0163845979</span>
    const orderPattern = /注文番号[\s\S]*?[：:]<\/span>[\s\S]*?<span[^>]*>(\d+-\d+-\d+)<\/span>/;
    const orderMatch = html.match(orderPattern);
    if (orderMatch) {
      latestOrderId = orderMatch[1]; // Full order number (e.g., 431906-20251214-0163845979)
      log.debug(`Order pattern matched: ${latestOrderId}`);
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
