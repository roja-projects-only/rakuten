const { ALLOWED_DOMAINS } = require('./constants');

function parseColonCredential(line, { allowPrefix = false } = {}) {
  if (!line || typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const parts = trimmed.split(':');
  if (!allowPrefix && parts.length !== 2) return null;
  if (allowPrefix && parts.length < 2) return null;

  // For allowPrefix, accept formats like url:email:pass and use the last two segments.
  const user = allowPrefix ? parts[parts.length - 2].trim() : parts[0].trim();
  const pass = allowPrefix ? parts[parts.length - 1].trim() : parts[1].trim();
  if (!user || !pass || !user.includes('@')) return null;

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
