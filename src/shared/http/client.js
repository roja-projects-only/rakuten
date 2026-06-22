/**
 * =============================================================================
 * HTTP CLIENT - IMPIT-BASED REQUEST HANDLER WITH TLS IMPERSONATION
 * =============================================================================
 *
 * Provides a configured HTTP client with:
 * - Chrome TLS/JA3/JA4 fingerprint impersonation via impit (Rust native)
 * - Automatic cookie management via tough-cookie jar (passed to impit)
 * - Coherent browser profile headers (UA, sec-ch-ua, Accept-Language, etc.)
 * - Proxy support (HTTP, HTTPS, SOCKS4, SOCKS5) with TLS error tolerance
 * - Axios-compatible API (client.get/post) for minimal caller changes
 * - Network-error retry with exponential backoff
 * - Connection pooling (one Impit instance = one connection pool)
 *
 * The adapter exposes an axios-like interface so flow.js, capture modules,
 * and ipFetcher.js can use client.get/post with the same config shape.
 *
 * =============================================================================
 */

const { Impit } = require('impit');
const { CookieJar } = require('tough-cookie');
const { createLogger } = require('../logger');
const { withRetry } = require('./retryInterceptor');

const log = createLogger('http-client');

/**
 * Parses various proxy formats into a standard config object.
 * Supported formats:
 *   - host:port
 *   - host:port:user:pass
 *   - user:pass@host:port
 *   - http://host:port
 *   - http://user:pass@host:port
 *   - socks5://user:pass@host:port
 * @param {string} proxy - Proxy string in any format
 * @returns {Object|null} { host, port, auth? } or null if invalid
 */
function parseProxy(proxy) {
  if (!proxy || typeof proxy !== 'string') return null;

  const trimmed = proxy.trim();
  if (!trimmed) return null;

  // Try parsing as URL first (handles http://, socks5://, etc.)
  if (trimmed.includes('://')) {
    try {
      const url = new URL(trimmed);
      const result = {
        host: url.hostname,
        port: parseInt(url.port, 10) || 80,
        protocol: url.protocol.replace(':', ''),
      };
      if (url.username && url.password) {
        result.auth = {
          username: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
        };
      }
      return result;
    } catch (_) {
      const withoutScheme = trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//, '');
      const schemeParts = withoutScheme.split(':');
      if (schemeParts.length === 4) {
        const port = parseInt(schemeParts[1], 10);
        if (!isNaN(port)) {
          return {
            host: schemeParts[0],
            port,
            auth: { username: schemeParts[2], password: schemeParts[3] },
          };
        }
      }
    }
  }

  // Format: user:pass@host:port
  const atMatch = trimmed.match(/^([^:]+):([^@]+)@([^:]+):(\d+)$/);
  if (atMatch) {
    return {
      host: atMatch[3],
      port: parseInt(atMatch[4], 10),
      auth: { username: atMatch[1], password: atMatch[2] },
    };
  }

  // Format: host:port:user:pass
  const fourParts = trimmed.split(':');
  if (fourParts.length === 4) {
    const port = parseInt(fourParts[1], 10);
    if (!isNaN(port)) {
      return {
        host: fourParts[0],
        port,
        auth: { username: fourParts[2], password: fourParts[3] },
      };
    }
  }

  // Format: host:port
  const twoParts = trimmed.split(':');
  if (twoParts.length === 2) {
    const port = parseInt(twoParts[1], 10);
    if (!isNaN(port)) {
      return { host: twoParts[0], port };
    }
  }

  // Try adding http:// and parse as URL
  try {
    const url = new URL(`http://${trimmed}`);
    if (url.hostname && url.port) {
      const result = { host: url.hostname, port: parseInt(url.port, 10) };
      if (url.username && url.password) {
        result.auth = {
          username: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
        };
      }
      return result;
    }
  } catch (_) {}

  log.warn(`Unable to parse proxy format: ${trimmed}`);
  return null;
}

/**
 * Converts a parsed proxy config to a URL string for impit's proxyUrl option.
 * @param {string} proxy - Proxy string in any format
 * @returns {string|undefined} Proxy URL string or undefined if no proxy
 */
function parseProxyToUrl(proxy) {
  if (!proxy) return undefined;
  const parsed = parseProxy(proxy);
  if (!parsed) return undefined;
  const protocol = parsed.protocol || 'http';
  const auth = parsed.auth
    ? `${encodeURIComponent(parsed.auth.username)}:${encodeURIComponent(parsed.auth.password)}@`
    : '';
  return `${protocol}://${auth}${parsed.host}:${parsed.port}`;
}

/**
 * Converts a fetch Headers object to a plain object with lowercase keys.
 * Handles set-cookie as an array (matching axios behavior).
 * @param {Headers} headers - Fetch Headers object
 * @returns {Object} Plain object with lowercase header keys
 */
function headersToObject(headers) {
  const obj = {};
  try {
    headers.forEach((value, key) => {
      obj[key.toLowerCase()] = value;
    });
  } catch (_) {
    // Fallback: try get() for known headers
    const known = ['content-type', 'set-cookie', 'location', 'content-length'];
    for (const h of known) {
      const v = headers.get(h);
      if (v) obj[h] = v;
    }
  }
  // Ensure set-cookie is an array (axios behavior)
  if (typeof headers.getSetCookie === 'function') {
    const setCookies = headers.getSetCookie();
    if (setCookies && setCookies.length > 0) {
      obj['set-cookie'] = setCookies;
    }
  }
  return obj;
}

/**
 * Builds default browser-like headers from a profile.
 * @param {Object} profile - Browser profile from browserProfile.generateProfile()
 * @returns {Object} Default headers
 */
function buildDefaultHeaders(profile) {
  const p = profile || {};
  return {
    'User-Agent': p.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': p.acceptLanguage || 'en-US,en;q=0.9',
    'Accept-Encoding': p.acceptEncoding || 'gzip, deflate, br, zstd',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    ...(p.secChUa ? {
      'sec-ch-ua': p.secChUa,
      'sec-ch-ua-mobile': p.secChUaMobile || '?0',
      'sec-ch-ua-platform': p.secChUaPlatform,
    } : {}),
  };
}

/**
 * Performs a single HTTP request via impit and returns an axios-like response.
 * @param {Impit} impit - Impit instance
 * @param {string} method - HTTP method (GET, POST)
 * @param {string} url - Request URL
 * @param {*} data - Request body (for POST)
 * @param {Object} config - Request config (headers, timeout, maxRedirects, __noRetry)
 * @param {Object} defaultHeaders - Default headers from client
 * @param {Object} jar - tough-cookie CookieJar (for manual Set-Cookie on manual redirects)
 * @returns {Promise<Object>} Axios-like response
 */
async function performRequest(impit, method, url, data, config, defaultHeaders, jar) {
  // Merge headers: defaults < per-request
  const headers = { ...defaultHeaders, ...(config.headers || {}) };

  // Serialize body and set Content-Type
  let body = undefined;
  if (data !== undefined && data !== null) {
    if (typeof data === 'string' || Buffer.isBuffer(data)) {
      body = data;
    } else if (data instanceof URLSearchParams) {
      body = data.toString();
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    } else {
      body = JSON.stringify(data);
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  // Per-request timeout
  const timeout = config.timeout;

  // Redirect handling: maxRedirects: 0 → manual; else follow (instance max applies)
  const redirect = config.maxRedirects === 0 ? 'manual' : 'follow';

  // Build fetch options
  const fetchOpts = { method, headers, redirect };
  if (timeout) fetchOpts.timeout = timeout;
  if (body !== undefined) fetchOpts.body = body;

  // Execute with optional retry (withRetry returns a function — must call it)
  const doFetch = () => impit.fetch(url, fetchOpts);
  const response = config.__noRetry ? await doFetch() : await withRetry(doFetch, { retries: 3 })();

  // Parse response body (can only read once)
  const contentType = response.headers.get('content-type') || '';
  let parsedData;
  if (contentType.includes('application/json')) {
    try {
      parsedData = await response.json();
    } catch (_) {
      parsedData = await response.text();
    }
  } else {
    parsedData = await response.text();
  }

  // For manual-redirect responses, extract Set-Cookie into the jar
  // (impit only auto-processes cookies when following redirects)
  if (redirect === 'manual' && jar) {
    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
    for (const cookie of setCookies) {
      try { await jar.setCookie(cookie, url); } catch (_) {}
    }
  }

  // Build axios-like response object
  const headersObj = headersToObject(response.headers);

  return {
    status: response.status,
    statusText: response.statusText,
    data: parsedData,
    headers: headersObj,
    config: { url, method, headers },
    request: { res: { responseUrl: response.url || url } },
  };
}

/**
 * Creates a new HTTP client instance with TLS impersonation and cookie management.
 * @param {Object} options - Client configuration options
 * @param {string} [options.proxy] - Proxy in any format (host:port, user:pass@host:port, http://..., socks5://...)
 * @param {number} [options.timeout=60000] - Request timeout in milliseconds
 * @param {string} [options.userAgent] - Custom User-Agent (profile UA used if not provided)
 * @param {CookieJar} [options.jar] - Existing cookie jar to reuse across clients
 * @param {Object} [options.profile] - Browser profile from browserProfile.generateProfile()
 * @returns {{ client: Object, jar: CookieJar }} Axios-compatible client and cookie jar
 */
function createHttpClient(options = {}) {
  const {
    proxy = null,
    timeout = 60000,
    userAgent = null,
    jar: externalJar = null,
    profile = null,
  } = options;

  // Create cookie jar for session management
  const jar = externalJar || new CookieJar();

  // Determine browser preset and proxy URL from profile
  const browser = profile?.impitBrowser || 'chrome131';
  const proxyUrl = proxy ? parseProxyToUrl(proxy) : undefined;

  // Override profile UA if custom UA provided
  const effectiveProfile = userAgent && profile
    ? { ...profile, userAgent }
    : profile || { userAgent: userAgent };

  // Build default headers from profile
  const defaultHeaders = buildDefaultHeaders(effectiveProfile);
  if (userAgent) defaultHeaders['User-Agent'] = userAgent;

  // Create impit instance with TLS impersonation + cookie jar + proxy
  const impit = new Impit({
    browser,
    proxyUrl,
    cookieJar: jar,
    ignoreTlsErrors: true, // Required for proxies with SSL interception (BrightData, etc.)
    followRedirects: true,
    maxRedirects: 10,
    timeout,
    headers: defaultHeaders,
  });

  if (proxyUrl) {
    const parsed = parseProxy(proxy);
    log.debug(`Proxy configured (impit): ${parsed?.host}:${parsed?.port}${parsed?.auth ? ' (with auth)' : ''} [browser=${browser}]`);
  } else {
    log.debug(`HTTP client created [browser=${browser}]`);
  }

  // Build axios-compatible adapter
  const client = {
    defaults: { headers: { common: defaultHeaders } },
    // Stub interceptors for backward compatibility (not used — cookies/retry handled internally)
    interceptors: {
      request: { use: () => 0, eject: () => {} },
      response: { use: () => 0, eject: () => {} },
    },
    get: (url, config = {}) => performRequest(impit, 'GET', url, undefined, config, defaultHeaders, jar),
    post: (url, data, config = {}) => performRequest(impit, 'POST', url, data, config, defaultHeaders, jar),
    put: (url, data, config = {}) => performRequest(impit, 'PUT', url, data, config, defaultHeaders, jar),
    delete: (url, config = {}) => performRequest(impit, 'DELETE', url, undefined, config, defaultHeaders, jar),
  };

  return { client, jar };
}

/**
 * Gets all cookies for a specific URL from the jar.
 * @param {CookieJar} jar - Cookie jar instance
 * @param {string} url - URL to get cookies for
 * @returns {Promise<Array>} Array of cookie objects
 */
async function getCookies(jar, url) {
  try {
    const cookies = await jar.getCookies(url);
    return cookies;
  } catch (err) {
    log.warn('Failed to get cookies:', err.message);
    return [];
  }
}

/**
 * Gets all cookies as a string for Cookie header.
 * @param {CookieJar} jar - Cookie jar instance
 * @param {string} url - URL to get cookies for
 * @returns {Promise<string>} Cookie string
 */
async function getCookieString(jar, url) {
  try {
    const cookieString = await jar.getCookieString(url);
    return cookieString;
  } catch (err) {
    log.warn('Failed to get cookie string:', err.message);
    return '';
  }
}

/**
 * Sets cookies in the jar from Set-Cookie headers.
 * @param {CookieJar} jar - Cookie jar instance
 * @param {Array<string>} setCookieHeaders - Set-Cookie header values
 * @param {string} url - URL to associate cookies with
 * @returns {Promise<void>}
 */
async function setCookies(jar, setCookieHeaders, url) {
  if (!setCookieHeaders || !Array.isArray(setCookieHeaders)) {
    return;
  }

  for (const cookieHeader of setCookieHeaders) {
    try {
      await jar.setCookie(cookieHeader, url);
    } catch (err) {
      log.warn('Failed to set cookie:', err.message);
    }
  }
}

module.exports = {
  createHttpClient,
  parseProxy,
  parseProxyToUrl,
  getCookies,
  getCookieString,
  setCookies,
};