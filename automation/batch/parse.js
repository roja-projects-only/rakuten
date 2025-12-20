const { ALLOWED_DOMAINS } = require('./constants');

/**
 * Parse credential from colon-separated line.
 * @param {string} line - Input line
 * @param {Object} options - Parsing options
 * @param {boolean} options.allowPrefix - Allow URL prefix (ULP format: url:user:pass)
 * @param {boolean} options.requireEmail - Require @ in username (default: true for backward compat)
 * @returns {Object|null} { user, pass } or null if invalid
 */
function parseColonCredential(line, { allowPrefix = false, requireEmail = true } = {}) {
  if (!line || typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const parts = trimmed.split(':');
  if (!allowPrefix && parts.length !== 2) return null;
  if (allowPrefix && parts.length < 2) return null;

  // For allowPrefix (ULP format), we need to handle URLs with protocols (https://)
  // URL structure: protocol://domain/path:user:pass
  // After split by ':', we get: ['https', '//domain/path', 'user', 'pass']
  // So user is at index -2 and pass is at index -1
  let user, pass;
  
  if (allowPrefix) {
    // ULP format: take last two parts as user:pass
    user = parts[parts.length - 2].trim();
    pass = parts[parts.length - 1].trim();
    
    // Handle edge case where user part might start with // from URL (e.g., "https://site.com:user:pass")
    // In this case parts = ['https', '//site.com', 'user', 'pass'] - user is correct
    // But for "https://site.com/:user:pass" parts = ['https', '//site.com/', 'user', 'pass']
    // User should not start with '//' or be a URL path
    if (user.startsWith('//') || user.startsWith('/')) {
      return null;
    }
  } else {
    user = parts[0].trim();
    pass = parts[1].trim();
  }

  if (!user || !pass) return null;
  
  // Only require @ if explicitly requested (default for backward compatibility)
  if (requireEmail && !user.includes('@')) return null;

  return { user, pass };
}

function isAllowedHotmailUser(user) {
  const domain = user.split('@')[1];
  if (!domain) return false;
  const lower = domain.toLowerCase();
  return ALLOWED_DOMAINS.some((d) => lower.endsWith(d));
}

module.exports = {
  parseColonCredential,
  isAllowedHotmailUser,
};
