/**
 * =============================================================================
 * HTTP CLIENT - AXIOS-BASED REQUEST HANDLER WITH COOKIE MANAGEMENT
 * =============================================================================
 * 
 * Provides a configured HTTP client with:
 * - Automatic cookie jar management
 * - Browser-like headers
 * - User-Agent rotation
 * - Proxy support
 * - Request/response interceptors
 * 
 * NOTE: When using a proxy, we use manual cookie handling via interceptors
 * because axios-cookiejar-support doesn't work with custom HTTP agents.
 * 
 * =============================================================================
 */

const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const UserAgent = require('user-agents');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const { createLogger } = require('../../logger');
const { attachProxyRedirectCookieHandling } = require('./proxyRedirectCookieTracker');

const log = createLogger('http-client');

// Track if we've already warned about TLS bypass
let tlsBypassWarned = false;

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
      // Fall through to other formats
    }
  }
  
  // Format: user:pass@host:port
  const atMatch = trimmed.match(/^([^:]+):([^@]+)@([^:]+):(\d+)$/);
  if (atMatch) {
    return {
      host: atMatch[3],
      port: parseInt(atMatch[4], 10),
      auth: {
        username: atMatch[1],
        password: atMatch[2],
      },
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
        auth: {
          username: fourParts[2],
          password: fourParts[3],
        },
      };
    }
  }
  
  // Format: host:port
  const twoParts = trimmed.split(':');
  if (twoParts.length === 2) {
    const port = parseInt(twoParts[1], 10);
    if (!isNaN(port)) {
      return {
        host: twoParts[0],
        port,
      };
    }
  }
  
  // Try adding http:// and parse as URL
  try {
    const url = new URL(`http://${trimmed}`);
    if (url.hostname && url.port) {
      const result = {
        host: url.hostname,
        port: parseInt(url.port, 10),
      };
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
 * Creates a new HTTP client instance with cookie jar and browser-like configuration.
 * @param {Object} options - Client configuration options
 * @param {string} [options.proxy] - Proxy in any format (host:port, user:pass@host:port, http://..., etc.)
 * @param {number} [options.timeout=60000] - Request timeout in milliseconds
 * @param {string} [options.userAgent] - Custom User-Agent (random if not provided)
 * @returns {Object} Axios instance with cookie jar
 */
function createHttpClient(options = {}) {
  const {
    proxy = null,
    timeout = 60000,
    userAgent = new UserAgent().toString(),
  } = options;

  // Create cookie jar for session management
  const jar = new CookieJar();
  
  // Determine if we need manual cookie handling (when using proxy)
  const proxyConfig = proxy ? parseProxy(proxy) : null;
  const useManualCookies = !!proxyConfig;
  
  // Create axios instance - only wrap with cookie support if NO proxy
  let client;
  if (useManualCookies) {
    // Manual cookie handling for proxy support
    client = axios.create({
      timeout,
      withCredentials: true,
      maxRedirects: 5,
      validateStatus: (status) => status < 600,
    });
  } else {
    // Use axios-cookiejar-support when no proxy
    client = wrapper(axios.create({
      timeout,
      jar,
      withCredentials: true,
      maxRedirects: 5,
      validateStatus: (status) => status < 600,
    }));
  }

  // Configure proxy with tunnel agents
  if (proxyConfig) {
    const proxyProtocol = proxyConfig.protocol || 'http';
    let proxyUrl;
    if (proxyConfig.auth) {
      proxyUrl = `${proxyProtocol}://${encodeURIComponent(proxyConfig.auth.username)}:${encodeURIComponent(proxyConfig.auth.password)}@${proxyConfig.host}:${proxyConfig.port}`;
    } else {
      proxyUrl = `${proxyProtocol}://${proxyConfig.host}:${proxyConfig.port}`;
    }
    
    // Create tunnel agents for proper HTTPS proxying
    // Disable SSL verification to allow proxies with SSL interception (BrightData, etc.)
    // This is necessary because residential proxies often use self-signed certs
    const httpsAgent = new HttpsProxyAgent(proxyUrl);
    const httpAgent = new HttpProxyAgent(proxyUrl);
    
    client.defaults.httpsAgent = httpsAgent;
    client.defaults.httpAgent = httpAgent;
    client.defaults.proxy = false; // Disable axios built-in proxy
    
    // Disable TLS verification globally for this proxy session
    // This is required for BrightData and similar proxies that perform SSL interception
    if (!tlsBypassWarned) {
      log.warn('SSL certificate verification disabled for proxy connections');
      tlsBypassWarned = true;
    }
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    
    log.debug(`Proxy configured (tunnel): ${proxyConfig.host}:${proxyConfig.port}${proxyConfig.auth ? ' (with auth)' : ''}`);
  }

  // Attach redirect-aware cookie handling only for proxy mode so we capture Set-Cookie from every hop
  if (useManualCookies) {
    attachProxyRedirectCookieHandling(client, jar);
  }

  // Set default headers (browser-like)
  client.defaults.headers.common['User-Agent'] = userAgent;
  client.defaults.headers.common['Accept-Language'] = 'en-US,en;q=0.9,ja;q=0.8';
  client.defaults.headers.common['Accept-Encoding'] = 'gzip, deflate, br';
  client.defaults.headers.common['DNT'] = '1';
  client.defaults.headers.common['Connection'] = 'keep-alive';
  client.defaults.headers.common['Upgrade-Insecure-Requests'] = '1';

  // Manual cookie handling interceptors (only when using proxy)
  if (useManualCookies) {
    // Request interceptor - add cookies from jar
    client.interceptors.request.use(
      async (config) => {
        try {
          const url = config.url;
          // Build full URL for cookie lookup
          const fullUrl = url.startsWith('http') ? url : `${config.baseURL || ''}${url}`;
          const cookieString = await jar.getCookieString(fullUrl);
          if (cookieString) {
            config.headers = config.headers || {};
            // Merge with existing Cookie header if present
            const existingCookie = config.headers['Cookie'] || config.headers['cookie'] || '';
            config.headers['Cookie'] = existingCookie ? `${existingCookie}; ${cookieString}` : cookieString;
          }
        } catch (err) {
          log.debug(`Cookie injection error: ${err.message}`);
        }
        log.debug(`${config.method.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        log.error('Request error:', error.message);
        return Promise.reject(error);
      }
    );

    // Response interceptor - save cookies to jar
    client.interceptors.response.use(
      async (response) => {
        try {
          const url = response.config.url;
          const fullUrl = url.startsWith('http') ? url : `${response.config.baseURL || ''}${url}`;
          const setCookieHeaders = response.headers['set-cookie'];
          if (setCookieHeaders) {
            const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
            for (const cookie of cookies) {
              try {
                await jar.setCookie(cookie, fullUrl);
              } catch (cookieErr) {
                log.debug(`Failed to set cookie: ${cookieErr.message}`);
              }
            }
          }
        } catch (err) {
          log.debug(`Cookie extraction error: ${err.message}`);
        }
        log.debug(`${response.status} ${response.config.url}`);
        return response;
      },
      async (error) => {
        // Also try to extract cookies from error responses
        if (error.response) {
          try {
            const url = error.config.url;
            const fullUrl = url.startsWith('http') ? url : `${error.config.baseURL || ''}${url}`;
            const setCookieHeaders = error.response.headers['set-cookie'];
            if (setCookieHeaders) {
              const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
              for (const cookie of cookies) {
                try {
                  await jar.setCookie(cookie, fullUrl);
                } catch (_) {}
              }
            }
          } catch (_) {}
          log.warn(`${error.response.status} ${error.config.url}`);
        } else {
          log.error('Response error:', error.message);
        }
        return Promise.reject(error);
      }
    );
  } else {
    // Standard logging interceptors (no proxy case)
    client.interceptors.request.use(
      (config) => {
        log.debug(`${config.method.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        log.error('Request error:', error.message);
        return Promise.reject(error);
      }
    );

    client.interceptors.response.use(
      (response) => {
        log.debug(`${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        if (error.response) {
          log.warn(`${error.response.status} ${error.config.url}`);
        } else {
          log.error('Response error:', error.message);
        }
        return Promise.reject(error);
      }
    );
  }

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
  getCookies,
  getCookieString,
  setCookies,
};
