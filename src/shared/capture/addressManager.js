/**
 * =============================================================================
 * ADDRESS MANAGER - Add shipping address via cart.step.rakuten.co.jp
 * =============================================================================
 */

const crypto = require('crypto');
const { createLogger } = require('../logger');
const { hasSsoForm, followSsoRedirects } = require('./ssoFormHandler');

const log = createLogger('address-manager');

// ─────────────────────────────────────────────────────────────────────────────
// Target shipping address
// ─────────────────────────────────────────────────────────────────────────────

const TARGET_ADDRESS = {
  postalCode: '306-0608',
  telFirst: '090',
  telSecond: '8558',
  telLast: '8190',
  prefectureId: '8',
  countryCode: 'JP',
  city: '坂東市',
  street: '幸神平1 C棟06室 PHHNPKPF',
};

// ─────────────────────────────────────────────────────────────────────────────
// Known item for add-to-cart (from HAR)
// ─────────────────────────────────────────────────────────────────────────────

const CART_ITEM = {
  productUrl: 'https://item.rakuten.co.jp/chisaya/applepen-2-new/',
  shopBid: '402705',
  itemId: '10004068',
  shopName: 'Select Opus',
};

// ─────────────────────────────────────────────────────────────────────────────
// API key extracted from checkout-step0 JS bundle
// ─────────────────────────────────────────────────────────────────────────────

const CART_API_KEY = 'hia0gcIOxz39gn1fKRJPzek4JAsSVOqPR';

// ─────────────────────────────────────────────────────────────────────────────
// API endpoints
// ─────────────────────────────────────────────────────────────────────────────

const DIRECT_CART_ADD_URL = 'https://direct.step.rakuten.co.jp/rms/mall/cartAdd/';
const CART_PAGE_URL = 'https://cart.step.rakuten.co.jp/cart';
const CART_SUBMIT_URL = 'https://ui-api.cart.step.rakuten.co.jp/cart/submit';
const CART_API_URL = 'https://ui-api.cart.step.rakuten.co.jp/cart';
const SHIPPING_ADDRESS_URL = 'https://ui-api.cart.step.rakuten.co.jp/shipping-address';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function generateRequestId() { return crypto.randomUUID(); }
function generateTabId() { return `T-${generateRequestId()}`; }

function buildUiApiHeaders({ csrfToken, tabId } = {}) {
  return {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json; charset=UTF-8',
    'Origin': 'https://cart.step.rakuten.co.jp',
    'Referer': 'https://cart.step.rakuten.co.jp/cart',
    'x-client-id': 'dui-pc',
    'x-csrf-token': csrfToken || 'undefined',
    'x-co-request-id': generateRequestId(),
    'x-client-tab-id': tabId,
    'x-api-key': CART_API_KEY,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Add item to cart via direct.step endpoint
//         Creates jichiba-checkout-context and cart-key cookies.
// ─────────────────────────────────────────────────────────────────────────────

async function addItemViaDirectCartAdd(client, timeoutMs) {
  log.debug('Adding item via direct cartAdd...');

  // First visit the product page to get item.rakuten.co.jp cookies
  await client.get(CART_ITEM.productUrl, {
    timeout: timeoutMs,
    maxRedirects: 10,
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
    },
    validateStatus: (s) => s < 500,
  });

  // POST to direct cartAdd — sets checkout-context and cart-key cookies
  const response = await client.post(DIRECT_CART_ADD_URL,
    `shop_bid=${CART_ITEM.shopBid}&item_id=${CART_ITEM.itemId}&units=1&device=pc`,
    {
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://item.rakuten.co.jp',
        'Referer': CART_ITEM.productUrl,
        'Accept': 'text/html,*/*',
      },
      validateStatus: (s) => s < 500,
    }
  );

  log.debug(`cartAdd response: ${response.status}`);
  return response.status;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Load cart page to stabilize cookies across subdomains
// ─────────────────────────────────────────────────────────────────────────────

async function loadCartPage(client, timeoutMs) {
  log.debug('Loading cart page...');
  const response = await client.get(CART_PAGE_URL, {
    timeout: timeoutMs,
    maxRedirects: 10,
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
    },
    validateStatus: (s) => s < 500,
  });

  const finalUrl = response.request?.res?.responseUrl || response.config?.url || '';
  const onCartPage = finalUrl.includes('cart.step.rakuten.co.jp/cart') && !finalUrl.includes('error');

  if (!onCartPage) {
    log.warn(`Cart page not reached: ${finalUrl.substring(0, 80)}`);
    return { success: false, html: null };
  }

  log.info('Cart page loaded');
  return {
    success: true,
    html: typeof response.data === 'string' ? response.data : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Get cart data from API (returns items, loggedIn state)
// ─────────────────────────────────────────────────────────────────────────────

async function getCartData(client, tabId, timeoutMs) {
  log.debug('Fetching cart data...');
  const response = await client.get(CART_API_URL, {
    timeout: timeoutMs,
    headers: {
      'Accept': 'application/json',
      'Origin': 'https://cart.step.rakuten.co.jp',
      'Referer': 'https://cart.step.rakuten.co.jp/cart',
      'x-client-id': 'dui-pc',
      'x-api-key': CART_API_KEY,
      'x-client-tab-id': tabId,
    },
  });

  const data = response.data || {};
  const isLoggedIn = data.checkoutUser?.isLoggedIn === true;
  log.debug(`Cart data: loggedIn=${isLoggedIn}, keys=${Object.keys(data).length}`);

  return { isLoggedIn, data };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: Attempt cart/submit
// ─────────────────────────────────────────────────────────────────────────────

async function tryCartSubmit(client, tabId, timeoutMs) {
  log.debug('Attempting cart/submit...');

  const response = await client.post(CART_SUBMIT_URL, {
    clientWidth: 1204,
    clientHeight: 963,
    canUseApplePay: false,
    orderMode: 'single',
    selectedExtendedWarranty: { [CART_ITEM.shopBid]: {} },
    selectedShops: [CART_ITEM.shopBid],
    callbackParams: { 'l2-id': 'step0_pc_purchase_1' },
    shopName: CART_ITEM.shopName,
  }, {
    timeout: timeoutMs,
    headers: buildUiApiHeaders({ tabId }),
    validateStatus: (s) => s < 500,
  });

  const data = response.data;

  if (!data.errorCode) {
    log.info('cart/submit successful');
    log.debug(`cart/submit response: ${JSON.stringify(data).substring(0, 500)}`);
    // Extract shippingAddressIds from the response
    return { success: true, data };
  }

  const code = data.errorCode;
  log.warn(`cart/submit returned ${code}`);
  log.debug(`cart/submit full response: ${JSON.stringify(data)}`);

  const reasons = {
    'UI-003': 'Cart not initialized — checkout-step0 JS bundle required',
    'UI-011': 'Cart session expired or needs reload',
    'UI-026': 'No items selected for shipping',
  };

  return { success: false, errorCode: code, reason: reasons[code] || `cart_submit_error:${code}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5: POST shipping address
// ─────────────────────────────────────────────────────────────────────────────

async function postShippingAddress(client, tabId, timeoutMs, nameInfo) {
  const { firstName, lastName, firstNameKana, lastNameKana } = nameInfo;

  const addressData = {
    firstName: firstName || ' ',
    lastName: lastName || ' ',
    firstNameKana: firstNameKana || ' ',
    lastNameKana: lastNameKana || ' ',
    postalCode: TARGET_ADDRESS.postalCode,
    telFirst: TARGET_ADDRESS.telFirst,
    telSecond: TARGET_ADDRESS.telSecond,
    telLast: TARGET_ADDRESS.telLast,
    prefectureId: TARGET_ADDRESS.prefectureId,
    countryCode: TARGET_ADDRESS.countryCode,
    city: TARGET_ADDRESS.city,
    street: TARGET_ADDRESS.street,
  };

  // Primary strategy: Minimal payload with registerToAddressBook:true
  // This works — the server registers the address to the account's address book
  log.debug('Posting shipping address (minimal payload)...');
  const response = await client.post(SHIPPING_ADDRESS_URL, {
    shippingAddress: addressData,
    registerToAddressBook: true,
    changeToDefault: false,
    requestFrom: 'order-confirmation-page',
  }, {
    timeout: timeoutMs,
    headers: buildUiApiHeaders({ tabId }),
    validateStatus: (s) => s < 500,
  });

  if (!response.data?.errorCode) {
    return { success: true };
  }

  log.debug(`Minimal payload returned ${response.data.errorCode}`);

  return { success: false, errorCode: response.data.errorCode };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

async function addShippingAddress(session, profile, options = {}) {
  const { timeoutMs = 60000 } = options;
  const client = session.directClient || session.client;
  const { jar } = session;

  if (!client || !jar) {
    return { success: false, alreadyExisted: false, error: 'no_client' };
  }

  // Parse name
  const name = profile?.name || '';
  const nameKana = profile?.nameKana || '';
  const nameParts = name.trim().split(/\s+/);
  const lastName = nameParts[0] || '';
  const firstName = nameParts.slice(1).join(' ') || '';
  const kanaParts = nameKana.trim().split(/\s+/);
  const lastNameKana = kanaParts[0] || '';
  const firstNameKana = kanaParts.slice(1).join(' ') || '';

  if (!lastName) {
    return { success: false, alreadyExisted: false, error: 'no_name' };
  }

  // Check if target address already exists on the account
  const hasProfileAddress = profile?.postalCode || profile?.state || profile?.city;
  if (hasProfileAddress) {
    const isTargetPostal = profile.postalCode === TARGET_ADDRESS.postalCode;
    const isTargetCity = profile.city && profile.city.includes('坂東');
    if (isTargetPostal && isTargetCity) {
      const existingAddr = [profile.postalCode, profile.state, profile.city, profile.addressLine1]
        .filter(Boolean).join(' ');
      log.info(`Address already set: ${existingAddr}`);
      return { success: true, alreadyExisted: true, address: existingAddr };
    }
  }

  const tabId = generateTabId();
  const startedAt = Date.now();

  try {
    log.info(`Attempting address addition for: ${name}`);

    // Step 1: Add item to cart via direct cartAdd (creates checkout context cookies)
    const added = await addItemViaDirectCartAdd(client, timeoutMs);
    if (added === 0 || !added) {
      return { success: false, alreadyExisted: false, error: `cart_add_failed:${added || 'unknown'}` };
    }

    // Step 2: Load cart page to stabilize cookies
    const cartPage = await loadCartPage(client, timeoutMs);
    if (!cartPage.success) {
      return { success: false, alreadyExisted: false, error: 'cart_page_failed' };
    }

    // Step 3: Get cart data
    const cartData = await getCartData(client, tabId, timeoutMs);
    if (!cartData.isLoggedIn) {
      return { success: false, alreadyExisted: false, error: 'not_logged_in_cart' };
    }

    // Step 4: Try cart/submit
    const submitResult = await tryCartSubmit(client, tabId, timeoutMs);
    if (!submitResult.success) {
      log.warn(`Address addition blocked: ${submitResult.reason}`);
      return {
        success: false,
        alreadyExisted: false,
        error: submitResult.reason,
      };
    }

    // Step 5: Follow SSO redirect from cart/submit → order-confirmation
    log.debug('Following SSO chain after cart/submit...');

    if (submitResult.data?.redirectUrl) {
      let response = await client.get(submitResult.data.redirectUrl, {
        timeout: timeoutMs,
        maxRedirects: 10,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
        },
        validateStatus: (s) => s < 500,
      });

      let html = response.data;
      let currentUrl = response.request?.res?.responseUrl || response.config?.url || '';
      log.debug(`After SSO redirect: ${currentUrl.substring(0, 80)}`);

      // Handle sessionAlign form
      if (hasSsoForm(html)) {
        const formResult = await followSsoRedirects(client, html, currentUrl, timeoutMs, 5);
        html = formResult.html;
        currentUrl = formResult.url;
        log.debug(`After sessionAlign: ${currentUrl.substring(0, 80)}`);
      }

      // If redirected past shipping to payment, navigate to shipping-address step
      if (currentUrl.includes('payment') && !currentUrl.includes('order-confirmation')) {
        log.debug('Redirected to payment — navigating to shipping-address step...');
        const shipAddrRes = await client.get('https://cart.step.rakuten.co.jp/order-confirmation/shipping-address', {
          timeout: timeoutMs,
          maxRedirects: 10,
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Sec-Fetch-Dest': 'document',
          },
          validateStatus: (s) => s < 500,
        });
        const shipUrl = shipAddrRes.request?.res?.responseUrl || shipAddrRes.config?.url || '';
        if (shipUrl.includes('order-confirmation') && !shipUrl.includes('error')) {
          log.info('Reached shipping-address step');
        }
      }
    }

    // Step 6: POST shipping address
    const addrResult = await postShippingAddress(client, tabId, timeoutMs, {
      firstName, lastName, firstNameKana, lastNameKana,
    });

    const durationMs = Date.now() - startedAt;

    if (addrResult.success) {
      const targetAddrStr = `${TARGET_ADDRESS.postalCode} ${TARGET_ADDRESS.city} ${TARGET_ADDRESS.street}`;
      log.info(`Address added in ${durationMs}ms: ${targetAddrStr}`);
      return { success: true, alreadyExisted: false, address: targetAddrStr, durationMs };
    }

    return { success: false, alreadyExisted: false, error: `post_failed:${addrResult.errorCode}` };
  } catch (error) {
    log.error(`Address addition error: ${error.message}`);
    return { success: false, alreadyExisted: false, error: error.message };
  }
}

module.exports = {
  addShippingAddress,
  TARGET_ADDRESS,
};
