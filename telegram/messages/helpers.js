/**
 * =============================================================================
 * MESSAGE HELPERS - MarkdownV2 escape functions and utilities
 * =============================================================================
 */

const { Markup } = require('telegraf');

/**
 * Escapes text for MarkdownV2.
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeV2(text = '') {
  return String(text).replace(/[\\_*\[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

/**
 * Formats text as code span in MarkdownV2.
 * @param {string} text - Text to format
 * @returns {string} Formatted code span
 */
function codeV2(text = '') {
  const safe = String(text).replace(/[`\\]/g, '\\$&');
  return `\`${safe}\``;
}

/**
 * Formats text as bold in MarkdownV2.
 * @param {string} text - Text to format
 * @returns {string} Bold text
 */
function boldV2(text = '') {
  return `*${escapeV2(text)}*`;
}

/**
 * Formats text as spoiler in MarkdownV2.
 * @param {string} text - Text to format
 * @returns {string} Spoiler text
 */
function spoilerV2(text = '') {
  return `||${escapeV2(text)}||`;
}

/**
 * Formats text as spoiler code span in MarkdownV2.
 * @param {string} text - Text to format
 * @returns {string} Spoiler code span
 */
function spoilerCodeV2(text = '') {
  const safe = String(text).replace(/[`\\]/g, '\\$&');
  return `||\`${safe}\`||`;
}

/**
 * Formats text as italic in MarkdownV2.
 * @param {string} text - Text to format
 * @returns {string} Italic text
 */
function italicV2(text = '') {
  return `_${escapeV2(text)}_`;
}

/**
 * Masks email for privacy display.
 * @param {string} email - Email to mask
 * @returns {string} Masked email
 */
function maskEmail(email = '') {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const name = email.slice(0, at);
  if (name.length < 3) return '***';
  return `${name.slice(0, 3)}***${name.slice(-2)}`;
}

/**
 * Formats bytes as human-readable size.
 * @param {number} bytes - Bytes to format
 * @returns {string} Formatted size string
 */
function formatBytes(bytes) {
  if (!bytes || Number.isNaN(bytes)) return 'unknown';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

/**
 * Formats milliseconds as duration string.
 * @param {number} ms - Milliseconds to format
 * @returns {string} Formatted duration
 */
function formatDurationMs(ms) {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = (seconds % 60).toFixed(1);
  return `${minutes}m ${rem}s`;
}

/**
 * Alias for codeV2.
 * @param {string} text - Text to format
 * @returns {string} Code span
 */
function codeSpan(text) {
  return codeV2(text ?? '');
}

module.exports = {
  escapeV2,
  codeV2,
  boldV2,
  spoilerV2,
  spoilerCodeV2,
  italicV2,
  maskEmail,
  formatBytes,
  formatDurationMs,
  codeSpan,
  Markup,
};

