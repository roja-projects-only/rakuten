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
 * =============================================================================
 */

const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const UserAgent = require('user-agents');
const { createLogger } = require('../../logger');

const log = createLogger('http-client');

/**
 * Creates a new HTTP client instance with cookie jar and browser-like configuration.
 * @param {Object} options - Client configuration options
 * @param {string} [options.proxy] - Proxy URL (http://user:pass@host:port)
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
  
  // Create axios instance with cookie support
  const client = wrapper(axios.create({
    timeout,
    jar,
    withCredentials: true,
    maxRedirects: 5,
    validateStatus: (status) => status < 600, // Don't throw on any status
  }));

  // Configure proxy if provided
  if (proxy) {
    const proxyUrl = new URL(proxy);
    client.defaults.proxy = {
      host: proxyUrl.hostname,
      port: parseInt(proxyUrl.port, 10) || 80,
      auth: proxyUrl.username && proxyUrl.password ? {
        username: proxyUrl.username,
        password: proxyUrl.password,
      } : undefined,
    };
    log.debug(`Proxy configured: ${proxyUrl.hostname}:${proxyUrl.port}`);
  }

  // Set default headers (browser-like)
  client.defaults.headers.common['User-Agent'] = userAgent;
  client.defaults.headers.common['Accept-Language'] = 'en-US,en;q=0.9,ja;q=0.8';
  client.defaults.headers.common['Accept-Encoding'] = 'gzip, deflate, br';
  client.defaults.headers.common['DNT'] = '1';
  client.defaults.headers.common['Connection'] = 'keep-alive';
  client.defaults.headers.common['Upgrade-Insecure-Requests'] = '1';

  // Request interceptor for logging
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

  // Response interceptor for logging
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
  getCookies,
  getCookieString,
  setCookies,
};
