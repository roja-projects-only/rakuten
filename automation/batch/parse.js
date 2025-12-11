const { ALLOWED_DOMAINS } = require('./constants');

function parseColonCredential(line) {
  if (!line || typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const parts = trimmed.split(':');
  if (parts.length !== 2) return null;

  const user = parts[0].trim();
  const pass = parts[1].trim();
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
