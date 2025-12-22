/**
 * =============================================================================
 * IP FETCHER - External IP detection for proxy validation
 * =============================================================================
 * 
 * Fetches the exit IP address using a public API.
 * Validates that credentials are routed through the configured proxy.
 * 
 * =============================================================================
 */

const { createLogger } = require('../../logger');

const log = createLogger('ip-fetcher');

/**
 * Fetches the external IP address using the provided HTTP client.
 * Uses ipify.org for minimal latency and reliability.
 * 
 * @param {AxiosInstance} client - Axios HTTP client (with proxy already configured)
 * @param {number} [timeoutMs=10000] - Request timeout
 * @returns {Promise<Object>} IP info object: { ip, error? }
 */
async function fetchIpInfo(client, timeoutMs = 10000) {
  try {
    log.info('Fetching exit IP address via ipify.org');
    
    // Use ipify.org API for simplicity and speed
    // Returns { ip: "1.2.3.4" } as JSON
    const response = await client.get('https://api.ipify.org?format=json', {
      timeout: timeoutMs,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    });
    
    const ip = response.data?.ip;
    
    if (!ip) {
      log.warn('IP response missing "ip" field');
      return { ip: null, error: 'Invalid response format' };
    }
    
    log.info(`Exit IP address retrieved: ${ip}`);
    return { ip };
  } catch (error) {
    log.warn(`IP fetch error: ${error.message}`);
    return { ip: null, error: error.message };
  }
}

/**
 * Fetches IP info with fallback to alternative APIs if primary fails.
 * Uses sequential fallback: ipify → ipapi.co → ip-api.com
 * 
 * @param {AxiosInstance} client - Axios HTTP client
 * @param {number} [timeoutMs=10000] - Request timeout
 * @returns {Promise<Object>} IP info: { ip, source?, error? }
 */
async function fetchIpInfoWithFallback(client, timeoutMs = 10000) {
  const apis = [
    {
      name: 'ipify',
      url: 'https://api.ipify.org?format=json',
      extract: (data) => data.ip,
    },
    {
      name: 'ipapi.co',
      url: 'https://ipapi.co/json/',
      extract: (data) => data.ip,
    },
    {
      name: 'ip-api.com',
      url: 'https://ip-api.com/json/',
      extract: (data) => data.query,
    },
  ];
  
  for (const api of apis) {
    try {
      log.info(`Trying IP API: ${api.name}`);
      
      const response = await client.get(api.url, {
        timeout: timeoutMs / apis.length, // Divide timeout across APIs
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
      });
      
      const ip = api.extract(response.data);
      
      if (!ip) {
        log.warn(`${api.name}: Missing IP field`);
        continue;
      }
      
      log.info(`Exit IP address retrieved from ${api.name}: ${ip}`);
      return { ip, source: api.name };
    } catch (error) {
      log.warn(`${api.name} failed: ${error.message}`);
      continue;
    }
  }
  
  log.warn('All IP APIs failed - no exit IP available');
  return { ip: null, error: 'All IP APIs failed' };
}

module.exports = {
  fetchIpInfo,
  fetchIpInfoWithFallback,
};
