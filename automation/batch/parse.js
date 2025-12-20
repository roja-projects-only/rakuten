const { ALLOWED_DOMAINS } = require('./constants');

// Rakuten minimum username length (API returns INVALID_LENGTH for shorter)
const MIN_USERNAME_LENGTH = 6;

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
  if (!allowPrefix && parts.length < 2) return null;
  if (allowPrefix && parts.length < 3) return null; // Need at least URL:user:pass

  let user, pass;
  
  if (allowPrefix) {
    // ULP format: URL:user:pass (password may contain colons)
    // Find where the URL ends by looking for the username
    // URLs typically have format: https://domain.com/path or https://domain.com
    // After split by ':', we need to identify the username position
    
    // Strategy: Find first part that looks like a username (after URL parts)
    // URL parts are: 'https', '//domain.com/path', etc.
    // Username typically doesn't start with '//' and isn't 'https' or 'http'
    
    let userIndex = -1;
    for (let i = 1; i < parts.length - 1; i++) {
      const part = parts[i].trim();
      // Skip URL-like parts (start with //, contain .com/.jp/.org, etc. in a URL context)
      if (part.startsWith('//') || part.startsWith('/')) continue;
      if (part === '') continue;
      
      // This looks like a username - it's not a URL part
      // Take this as username, and everything after as password
      userIndex = i;
      break;
    }
    
    if (userIndex === -1 || userIndex >= parts.length - 1) {
      // Fallback: take second-to-last as user, last as pass
      user = parts[parts.length - 2].trim();
      pass = parts[parts.length - 1].trim();
    } else {
      user = parts[userIndex].trim();
      // Join all remaining parts as password (handles passwords with colons)
      pass = parts.slice(userIndex + 1).join(':').trim();
    }
    
    // Validate user doesn't look like a URL part
    if (user.startsWith('//') || user.startsWith('/') || user === '') {
      return null;
    }
  } else {
    // Simple format: user:pass (password may contain colons)
    user = parts[0].trim();
    // Join all remaining parts as password
    pass = parts.slice(1).join(':').trim();
  }

  if (!user || !pass) return null;
  
  // Only require @ if explicitly requested (default for backward compatibility)
  if (requireEmail && !user.includes('@')) return null;
  
  // Skip usernames that are too short (Rakuten requires minimum length)
  if (user.length < MIN_USERNAME_LENGTH) return null;

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
  MIN_USERNAME_LENGTH,
};
