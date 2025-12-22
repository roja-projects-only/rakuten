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

// IP detection services (ordered by reliability and speed)
const IP_SERVICES = [
  { url: 'https://api.ipify.org?format=json', parser: (data) => data?.ip },
  { url: 'https://ipinfo.io/json', parser: (data) => data?.ip },
  { url: 'https://api.myip.com', parser: (data) => data?.ip },
  { url: 'https://httpbin.org/ip', parser: (data) => data?.origin?.split(',')[0]?.trim() },
];

/**
 * Detects the external IP address using the provided HTTP client.
 * Tries multiple services with fallback.
 * 
 * @param {Object} client - Axios HTTP client instance
 * @param {Object} [options] - Detection options
 * @param {number} [options.timeout=10000] - Request timeout
 * @param {number} [options.maxAttempts=4] - Max services to try
 * @returns {Promise<string|null>} External IP address or null if detection failed
 */
async function detectExternalIp(client, options = {}) {
  const { timeout = 10000, maxAttempts = 4 } = options;
  
  log.debug(`[ip-detect] Starting IP detection (timeout=${timeout}ms, maxAttempts=${maxAttempts})`);
  
  for (let i = 0; i < Math.min(maxAttempts, IP_SERVICES.length); i++) {
    const service = IP_SERVICES[i];
    
    try {
      log.debug(`[ip-detect] Trying service ${i + 1}/${maxAttempts}: ${service.url}`);
      
      const response = await client.get(service.url, {
        timeout,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        // Don't follow redirects for IP check
        maxRedirects: 0,
        validateStatus: (status) => status === 200,
      });
      
      log.debug(`[ip-detect] Service responded: status=${response.status}, data=${JSON.stringify(response.data).substring(0, 100)}`);
      
      if (response.data) {
        const ip = service.parser(response.data);
        
        if (ip && isValidIp(ip)) {
          log.info(`[ip-detect] Detected external IP: ${ip}`);
          return ip;
        } else {
          log.debug(`[ip-detect] Invalid IP from response: ${ip}`);
        }
      }
    } catch (err) {
      log.debug(`[ip-detect] Service ${service.url} failed: ${err.code || err.message}`);
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
  if (!trimmed || trimmed.length < 7) {
    return false;
  }
  
  // IPv4 pattern
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4Pattern.test(trimmed)) {
    const parts = trimmed.split('.');
    return parts.every((part) => {
      const num = parseInt(part, 10);
      return num >= 0 && num <= 255;
    });
  }
  
  // IPv6 pattern (simplified - accept anything with colons)
  if (trimmed.includes(':')) {
    return /^[0-9a-fA-F:]+$/.test(trimmed);
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
