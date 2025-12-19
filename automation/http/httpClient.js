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
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const { createLogger } = require('../../logger');

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
  
  // Create axios instance with cookie support
  const client = wrapper(axios.create({
    timeout,
    jar,
    withCredentials: true,
    maxRedirects: 5,
    validateStatus: (status) => status < 600, // Don't throw on any status
  }));

  // Configure proxy if provided - use tunnel agents for proper HTTPS support
  if (proxy) {
    const proxyConfig = parseProxy(proxy);
    if (proxyConfig) {
      // Build proxy URL for the agent
      const proxyProtocol = proxyConfig.protocol || 'http';
      let proxyUrl;
      if (proxyConfig.auth) {
        proxyUrl = `${proxyProtocol}://${encodeURIComponent(proxyConfig.auth.username)}:${encodeURIComponent(proxyConfig.auth.password)}@${proxyConfig.host}:${proxyConfig.port}`;
      } else {
        proxyUrl = `${proxyProtocol}://${proxyConfig.host}:${proxyConfig.port}`;
      }
      
      // Create tunnel agents for proper HTTPS proxying (fixes certificate errors)
      const httpsAgent = new HttpsProxyAgent(proxyUrl);
      const httpAgent = new HttpProxyAgent(proxyUrl);
      
      client.defaults.httpsAgent = httpsAgent;
      client.defaults.httpAgent = httpAgent;
      client.defaults.proxy = false; // Disable axios built-in proxy (use agents instead)
      
      log.debug(`Proxy configured (tunnel): ${proxyConfig.host}:${proxyConfig.port}${proxyConfig.auth ? ' (with auth)' : ''}`);
    } else {
      log.warn(`Invalid proxy format, proceeding without proxy: ${proxy}`);
    }
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
  parseProxy,
  getCookies,
  getCookieString,
  setCookies,
};
