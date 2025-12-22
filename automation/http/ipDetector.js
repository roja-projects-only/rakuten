/**
 * =============================================================================
 * IP DETECTOR - External IP address detection via public APIs
 * =============================================================================
 * 
 * Detects the external IP address being used by the HTTP client.
 * Useful for verifying proxy connections and debugging.
 * 
 * Uses multiple fallback services for reliability.
 * 
 * =============================================================================
 */

const { createLogger } = require('../../logger');

const log = createLogger('ip-detect');

// IP detection services (ordered by reliability)
const IP_SERVICES = [
  { url: 'https://api.ipify.org?format=json', parser: (data) => data.ip },
  { url: 'https://ipinfo.io/json', parser: (data) => data.ip },
  { url: 'https://api.myip.com', parser: (data) => data.ip },
  { url: 'https://httpbin.org/ip', parser: (data) => data.origin?.split(',')[0]?.trim() },
];

/**
 * Detects the external IP address using the provided HTTP client.
 * Tries multiple services with fallback.
 * 
 * @param {Object} client - Axios HTTP client instance
 * @param {Object} [options] - Detection options
 * @param {number} [options.timeout=10000] - Request timeout
 * @param {number} [options.maxAttempts=2] - Max services to try
 * @returns {Promise<string|null>} External IP address or null if detection failed
 */
async function detectExternalIp(client, options = {}) {
  const { timeout = 10000, maxAttempts = 2 } = options;
  
  let attempts = 0;
  
  for (const service of IP_SERVICES) {
    if (attempts >= maxAttempts) {
      break;
    }
    
    attempts++;
    
    try {
      log.debug(`[ip-detect] Trying ${service.url}`);
      
      const response = await client.get(service.url, {
        timeout,
        headers: {
          'Accept': 'application/json',
        },
      });
      
      if (response.status === 200 && response.data) {
        const ip = service.parser(response.data);
        
        if (ip && isValidIp(ip)) {
          log.info(`[ip-detect] External IP: ${ip}`);
          return ip;
        }
      }
    } catch (err) {
      log.debug(`[ip-detect] Service ${service.url} failed: ${err.message}`);
    }
  }
  
  log.warn('[ip-detect] All IP detection services failed');
  return null;
}

/**
 * Validates an IP address string.
 * @param {string} ip - IP address to validate
 * @returns {boolean} True if valid IPv4 or IPv6
 */
function isValidIp(ip) {
  if (!ip || typeof ip !== 'string') {
    return false;
  }
  
  const trimmed = ip.trim();
  
  // IPv4 pattern
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4Pattern.test(trimmed)) {
    const parts = trimmed.split('.');
    return parts.every((part) => {
      const num = parseInt(part, 10);
      return num >= 0 && num <= 255;
    });
  }
  
  // IPv6 pattern (simplified)
  const ipv6Pattern = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::([0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}$|^([0-9a-fA-F]{1,4}:){1,7}:$/;
  if (ipv6Pattern.test(trimmed) || trimmed.includes('::')) {
    return true;
  }
  
  return false;
}

/**
 * Masks an IP address for privacy (shows first and last octet).
 * @param {string} ip - IP address to mask
 * @returns {string} Masked IP (e.g., "192.*.*.1")
 */
function maskIp(ip) {
  if (!ip) return 'unknown';
  
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.*.*.${parts[3]}`;
  }
  
  // For IPv6 or other formats, show truncated
  return ip.length > 10 ? ip.substring(0, 8) + '...' : ip;
}

module.exports = {
  detectExternalIp,
  isValidIp,
  maskIp,
};
