/**
 * =============================================================================
 * CAPTURE MESSAGES - Data capture related messages
 * =============================================================================
 */

const { escapeV2, boldV2, spoilerCodeV2 } = require('./helpers');

/**
 * Builds capture prompt message.
 * @returns {string} Prompt message
 */
function buildCapturePrompt() {
  return escapeV2('🔍 Proceed to capture data?');
}

/**
 * Builds capture expired message.
 * @returns {string} Expired message
 */
function buildCaptureExpired() {
  return escapeV2('⌛ Capture session expired. Send `.chk email:password` again to restart.');
}

/**
 * Builds capture summary message.
 * @param {Object} data - Capture data
 * @returns {string} Summary message
 */
function buildCaptureSummary({ points, cash, username, password }) {
  return (
    escapeV2('🗂️ Capture Summary') +
    `\n• ${boldV2('Points')}: ${escapeV2(points || 'n/a')}` +
    `\n• ${boldV2('Rakuten Cash')}: ${escapeV2(cash || 'n/a')}` +
    `\n• Username: ${spoilerCodeV2(username || 'unknown')}` +
    `\n• Password: ${spoilerCodeV2(password || 'hidden')}`
  );
}

/**
 * Builds capture failed message.
 * @param {string} message - Error message
 * @returns {string} Failed message
 */
function buildCaptureFailed(message) {
  return `⚠️ Capture failed: ${escapeV2(message)}`;
}

/**
 * Builds capture skipped message.
 * @returns {string} Skipped message
 */
function buildCaptureSkipped() {
  return escapeV2('❎ Data capture skipped. Send `.chk` again if you want to restart.');
}

module.exports = {
  buildCapturePrompt,
  buildCaptureExpired,
  buildCaptureSummary,
  buildCaptureFailed,
  buildCaptureSkipped,
};

