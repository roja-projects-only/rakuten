/**
 * =============================================================================
 * STATIC MESSAGES - Start, help, and guide messages
 * =============================================================================
 */

const { boldV2, codeV2 } = require('./helpers');

/**
 * Builds the start message.
 * @returns {string} Start message in MarkdownV2
 */
function buildStartMessage() {
  return (
    '🎌 ' + boldV2('Rakuten Credential Checker') +
    '\n\n' + '⚡ High\\-speed HTTP\\-based validation' +
    '\n\n' + '📖 ' + boldV2('Usage:') +
    '\n' + codeV2('.chk email:password') +
    '\n\n' + '🧭 ' + boldV2('Example:') +
    '\n' + codeV2('.chk user@rakuten.co.jp:mypass123') +
    '\n\n' + '✨ ' + boldV2('Features:') +
    '\n• Real\\-time status updates' +
    '\n• Auto\\-capture points \\& rank' +
    '\n• Credential masking' +
    '\n• Instant verification'
  );
}

/**
 * Builds the help message.
 * @returns {string} Help message in MarkdownV2
 */
function buildHelpMessage() {
  return (
    '❓ ' + boldV2('Help & Commands') +
    '\n\n' + boldV2('Check Credentials:') +
    '\n' + codeV2('.chk email:password') +
    '\n\n' + boldV2('Batch Processing:') +
    '\n• Send a file → choose filter type' +
    '\n• ' + codeV2('.ulp <url>') + ' — process from URL' +
    '\n• ' + codeV2('/combine') + ' — combine multiple files' +
    '\n• ' + codeV2('/stop') + ' — abort active batch' +
    '\n\n' + boldV2('Export:') +
    '\n• ' + codeV2('/export') + ' — export VALID credentials' +
    '\n\n' + boldV2('Status Codes:') +
    '\n✅ ' + codeV2('VALID') + ' — Login successful' +
    '\n❌ ' + codeV2('INVALID') + ' — Wrong credentials' +
    '\n🔒 ' + codeV2('BLOCKED') + ' — Account locked' +
    '\n⚠️ ' + codeV2('ERROR') + ' — Technical issue' +
    '\n\n' + boldV2('Result Includes:') +
    '\n• Points \\& Rakuten Cash balance' +
    '\n• Membership rank' +
    '\n• Latest order info' +
    '\n• Account profile details'
  );
}

/**
 * Builds the guide message.
 * @returns {string} Guide message in MarkdownV2
 */
function buildGuideMessage() {
  return (
    '📚 ' + boldV2('Quick Guide') +
    '\n1\\) Type ' + codeV2('.chk email:password') +
    '\n2\\) Wait for the check' +
    '\n3\\) Review the result' +
    '\n4\\) Capture data if valid'
  );
}

module.exports = {
  buildStartMessage,
  buildHelpMessage,
  buildGuideMessage,
};

