/**
 * Progress Tracker for Distributed Worker Architecture
 * 
 * Manages batch progress tracking with Redis persistence and Telegram updates.
 * Implements throttled progress updates and final summary generation.
 */

const { createStructuredLogger } = require('../logger/structured');
const { PROGRESS_TRACKER, PUBSUB_CHANNELS } = require('../redis/keys');

class ProgressTracker {
  constructor(redisClient, telegram) {
    this.redis = redisClient;
    this.telegram = telegram;
    this.logger = createStructuredLogger('ProgressTracker');
    
    // Track last update time per batch to implement throttling
    this.updateTimers = new Map(); // batchId -> last update timestamp
    
    // Track active progress trackers for coordinator restart recovery
    this.activeTrackers = new Map(); // batchId -> progress data
    
    // Throttle interval (longer to avoid Telegram 429s)
    this.throttleMs = 8000;
    
    // Progress polling interval (independent of heartbeats)
    this.pollingInterval = null;
    this.pollingFrequency = 8000; // Poll every 8 seconds
  }

  /**
   * Initialize progress tracking for a batch
   * @param {string} batchId - Batch identifier
   * @param {number} totalTasks - Total number of tasks
   * @param {number} chatId - Telegram chat ID
   * @param {number} messageId - Telegram message ID to edit
   * @param {string} filename - Batch filename for display
   * @returns {Promise<void>}
   */
  async initBatch(batchId, totalTasks, chatId, messageId, filename = null) {
    const progressData = {
      batchId,
      total: totalTasks,
      completed: 0,
      chatId,
      messageId,
      filename: filename || `batch-${batchId}`,
      startTime: Date.now(),
      counts: { VALID: 0, INVALID: 0, BLOCKED: 0, ERROR: 0 },
      validCreds: []
    };

    try {
      // Store progress tracker in Redis with 7-day TTL
      const key = PROGRESS_TRACKER.generate(batchId);
      await this.redis.executeCommand('setex', key, PROGRESS_TRACKER.ttl, JSON.stringify(progressData));
      
      // Initialize progress counter to 0
      const counterKey = PROGRESS_TRACKER.generateCounter(batchId);
      await this.redis.executeCommand('set', counterKey, 0);
      await this.redis.executeCommand('expire', counterKey, PROGRESS_TRACKER.ttl);
      
      // Initialize result counters
      const countsKey = PROGRESS_TRACKER.generateCounts(batchId);
      await this.redis.executeCommand('hset', countsKey, 
        'VALID', 0, 'INVALID', 0, 'BLOCKED', 0, 'ERROR', 0);
      await this.redis.executeCommand('expire', countsKey, PROGRESS_TRACKER.ttl);
      
      // Store in local cache for fast access
      this.activeTrackers.set(batchId, progressData);
      
      // Initialize throttle timer
      this.updateTimers.set(batchId, 0);
      
      // Start progress polling if not already running
      this.startProgressPolling();
      
      this.logger.info('Progress tracker initialized', {
        batchId,
        totalTasks,
        chatId,
        messageId,
        filename
      });
      
    } catch (error) {
      this.logger.error('Failed to initialize progress tracker', {
        batchId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Get progress data for a batch
   * @param {string} batchId - Batch identifier
   * @returns {Promise<Object|null>} Progress data or null if not found
   */
  async getProgressData(batchId) {
    try {
      // Try local cache first
      if (this.activeTrackers.has(batchId)) {
        return this.activeTrackers.get(batchId);
      }
      
      // Fallback to Redis
      const key = PROGRESS_TRACKER.generate(batchId);
      const data = await this.redis.executeCommand('get', key);
      
      if (!data) {
        return null;
      }
      
      const progressData = JSON.parse(data);
      
      // Update local cache
      this.activeTrackers.set(batchId, progressData);
      
      return progressData;
      
    } catch (error) {
      this.logger.error('Failed to get progress data', {
        batchId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Check if a batch exists and is being tracked
   * @param {string} batchId - Batch identifier
   * @returns {Promise<boolean>}
   */
  async batchExists(batchId) {
    try {
      const progressData = await this.getProgressData(batchId);
      return progressData !== null;
    } catch (error) {
      this.logger.error('Failed to check batch existence', {
        batchId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Handle progress update from worker (called on Redis pub/sub event)
   * Implements 2-second throttling per batch to prevent Telegram rate limiting
   * @param {string} batchId - Batch identifier
   * @returns {Promise<void>}
   */
  async handleProgressUpdate(batchId) {
    try {
      const now = Date.now();
      const lastUpdate = this.updateTimers.get(batchId) || 0;
      
      // Get progress data
      const progressData = await this.getProgressData(batchId);
      if (!progressData) {
        this.logger.warn('Progress update for unknown batch', { batchId });
        return;
      }
      
      // Fetch current completed count from Redis
      const counterKey = PROGRESS_TRACKER.generateCounter(batchId);
      const completedStr = await this.redis.executeCommand('get', counterKey);
      const completed = parseInt(completedStr) || 0;
      
      // Fetch result counts from Redis
      const countsKey = PROGRESS_TRACKER.generateCounts(batchId);
      const countsData = await this.redis.executeCommand('hgetall', countsKey);
      const counts = {
        VALID: parseInt(countsData.VALID) || 0,
        INVALID: parseInt(countsData.INVALID) || 0,
        BLOCKED: parseInt(countsData.BLOCKED) || 0,
        ERROR: parseInt(countsData.ERROR) || 0
      };
      
      // Fetch valid credentials from Redis
      const validCredsKey = PROGRESS_TRACKER.generateValidCreds(batchId);
      const validCredsData = await this.redis.executeCommand('lrange', validCredsKey, 0, -1);
      const validCreds = validCredsData.map(data => {
        try {
          return JSON.parse(data);
        } catch (e) {
          return null;
        }
      }).filter(Boolean);
      
      // Update local cache
      progressData.completed = completed;
      progressData.counts = counts;
      progressData.validCreds = validCreds;
      this.activeTrackers.set(batchId, progressData);

      // If complete, send summary immediately (don't wait for next poll)
      if (!progressData.aborted && completed >= progressData.total) {
        this.logger.info('Batch complete, sending summary', { batchId, completed, total: progressData.total });
        await this.sendSummary(batchId);
        return;
      }

      // Throttle only the Telegram edit, not the state refresh
      if (now - lastUpdate < this.throttleMs) {
        this.logger.debug('Progress update throttled (state refreshed)', {
          batchId,
          timeSinceLastUpdate: now - lastUpdate,
          throttleMs: this.throttleMs
        });
        return;
      }

      // Use the same progress message format as single-node mode
      const { buildBatchProgress } = require('../../telegram/messages');
      const progressMessage = buildBatchProgress({
        filename: progressData.filename,
        processed: completed,
        total: progressData.total,
        counts,
        validCreds,
        startTime: progressData.startTime
      });
      
      // Edit Telegram message (catch "not modified" errors)
      try {
        await this.telegram.editMessageText(
          progressData.chatId,
          progressData.messageId,
          undefined,
          progressMessage,
          { parse_mode: 'MarkdownV2' }
        );
        
        this.logger.debug('Progress message updated successfully', { batchId });
        
      } catch (error) {
        // Ignore "message not modified" errors - this is normal when progress hasn't changed
        if (error.message && error.message.includes('message is not modified')) {
          this.logger.debug('Progress message unchanged, skipping update', { batchId });
          return;
        }
        
        // Log other Telegram API errors but don't fail the update
        this.logger.warn('Failed to update Telegram progress message', {
          batchId,
          error: error.message,
          chatId: progressData.chatId,
          messageId: progressData.messageId
        });
        
        // Don't re-throw - progress tracking should continue even if Telegram fails
        return;
      }
      
      // Update throttle timer
      this.updateTimers.set(batchId, now);
      
      // Log structured batch progress
      this.logger.logBatchProgress({
        batchId,
        total: progressData.total,
        completed,
        percentage: Math.round((completed / progressData.total) * 100),
        counts,
        validCount: validCreds.length,
        estimatedTimeRemaining: this._calculateETA(progressData.startTime, completed, progressData.total),
        throughput: this._calculateThroughput(progressData.startTime, completed)
      });
      
      this.logger.debug('Progress update sent', {
        batchId,
        completed,
        total: progressData.total,
        counts,
        validCount: validCreds.length
      });
      
    } catch (error) {
      this.logger.error('Failed to handle progress update', {
        batchId,
        error: error.message,
        stack: error.stack
      });
      
      // Don't throw - progress updates are non-critical
      // Workers should continue processing even if progress updates fail
    }
  }

  /**
   * Subscribe to Redis pub/sub for progress events
   * Note: For now, we use polling instead of pub/sub since the Redis client wrapper
   * doesn't expose the native subscribe method. Progress updates happen via
   * handleProgressUpdate() called from the Coordinator's worker heartbeat handler.
   * @returns {Promise<void>}
   */
  async subscribeToProgressEvents() {
    try {
      // Pub/sub requires a dedicated Redis connection in ioredis
      // For now, progress updates are handled via polling in handleProgressUpdate()
      // which is called by the Coordinator when processing worker results
      
      this.logger.info('Progress event tracking initialized (polling mode)');
      
    } catch (error) {
      this.logger.error('Failed to initialize progress events', {
        error: error.message,
        stack: error.stack
      });
      // Don't throw - progress updates are non-critical
    }
  }

  /**
   * Start progress polling for all active batches
   * This ensures progress updates continue even if heartbeats are missed
   */
  startProgressPolling() {
    if (this.pollingInterval) {
      return; // Already running
    }

    this.pollingInterval = setInterval(async () => {
      try {
        // Poll progress for all active batches
        const activeBatchIds = Array.from(this.activeTrackers.keys());
        
        if (activeBatchIds.length === 0) {
          return;
        }

        this.logger.debug('Polling progress for active batches', {
          batchCount: activeBatchIds.length,
          batchIds: activeBatchIds
        });

        // Update progress for each active batch
        for (const batchId of activeBatchIds) {
          try {
            await this.handleProgressUpdate(batchId);
          } catch (error) {
            this.logger.warn('Failed to update progress during polling', {
              batchId,
              error: error.message
            });
          }
        }
      } catch (error) {
        this.logger.error('Progress polling error', {
          error: error.message,
          stack: error.stack
        });
      }
    }, this.pollingFrequency);

    this.logger.info('Progress polling started', {
      frequency: this.pollingFrequency,
      throttle: this.throttleMs
    });
  }

  /**
   * Stop progress polling
   */
  stopProgressPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      this.logger.info('Progress polling stopped');
    }
  }

  /**
   * Format progress message for Telegram
   * @param {Object} data - Progress data
   * @returns {string} Formatted message
   */
  _formatProgressMessage({ batchId, completed, total, percentage, progressBar, startTime }) {
    const { escapeV2, codeV2, boldV2 } = require('../../telegram/messages/helpers');
    
    const elapsed = Date.now() - startTime;
    const elapsedSeconds = Math.floor(elapsed / 1000);
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    const remainingSeconds = elapsedSeconds % 60;
    
    const elapsedStr = elapsedMinutes > 0 
      ? `${elapsedMinutes}m ${remainingSeconds}s`
      : `${elapsedSeconds}s`;
    
    // Estimate remaining time based on current rate
    let etaStr = '';
    if (completed > 0 && completed < total) {
      const rate = completed / (elapsed / 1000); // tasks per second
      const remaining = total - completed;
      const etaSeconds = Math.ceil(remaining / rate);
      const etaMinutes = Math.floor(etaSeconds / 60);
      const etaSecondsRem = etaSeconds % 60;
      
      etaStr = etaMinutes > 0 
        ? ` \\(ETA: ${etaMinutes}m ${etaSecondsRem}s\\)`
        : ` \\(ETA: ${etaSecondsRem}s\\)`;
    }
    
    return [
      `⏳ ${boldV2('Processing Batch')}`,
      '',
      `${escapeV2(progressBar)} ${codeV2(`${percentage}%`)}`,
      `${codeV2(`${completed}/${total}`)} credentials`,
      `${escapeV2('Elapsed:')} ${codeV2(elapsedStr)}${etaStr}`,
      '',
      `${escapeV2('Batch ID:')} ${codeV2(batchId)}`
    ].join('\n');
  }

  /**
   * Send final summary when batch completes
   * @param {string} batchId - Batch identifier
   * @returns {Promise<void>}
   */
  async sendSummary(batchId) {
    let progressData;

    try {
      // Get progress data
      progressData = await this.getProgressData(batchId);
      if (!progressData) {
        this.logger.warn('Cannot send summary for unknown batch', { batchId });
        await this._cleanupSilently(batchId, 'sendSummary:missing');
        return;
      }

      // If Telegram client is not ready (e.g., during crash recovery), skip edits but still clean up
      if (!this.telegram) {
        this.logger.warn('Telegram client unavailable during sendSummary, skipping edit', { batchId });
        await this._cleanupSilently(batchId, 'sendSummary:no-telegram');
        return;
      }
      
      // Get final counts and valid credentials from Redis
      const countsKey = PROGRESS_TRACKER.generateCounts(batchId);
      const countsData = await this.redis.executeCommand('hgetall', countsKey);
      const counts = {
        VALID: parseInt(countsData.VALID) || 0,
        INVALID: parseInt(countsData.INVALID) || 0,
        BLOCKED: parseInt(countsData.BLOCKED) || 0,
        ERROR: parseInt(countsData.ERROR) || 0
      };
      
      const validCredsKey = PROGRESS_TRACKER.generateValidCreds(batchId);
      const validCredsData = await this.redis.executeCommand('lrange', validCredsKey, 0, -1);
      const validCreds = validCredsData.map(data => {
        try {
          return JSON.parse(data);
        } catch (e) {
          return null;
        }
      }).filter(Boolean);
      
      // Calculate elapsed time
      const elapsed = Date.now() - progressData.startTime;
      
      // Use the same summary format as single-node mode
      const { buildBatchSummary } = require('../../telegram/messages');
      const summaryMessage = buildBatchSummary({
        filename: progressData.filename,
        total: progressData.total,
        skipped: 0, // No skipped in distributed mode
        counts,
        elapsedMs: elapsed,
        validCreds
      });
      
      // Edit the progress message to show final summary
      await this.telegram.editMessageText(
        progressData.chatId,
        progressData.messageId,
        undefined,
        summaryMessage,
        { parse_mode: 'MarkdownV2' }
      );
      
      this.logger.info('Batch summary sent', {
        batchId,
        total: progressData.total,
        counts,
        validCount: validCreds.length,
        elapsed
      });
      
    } catch (error) {
      this.logger.error('Failed to send batch summary', {
        batchId,
        error: error.message,
        stack: error.stack
      });
    } finally {
      // Always clean up to stop further progress polling even if Telegram returns 429
      await this._cleanupSilently(batchId, 'sendSummary:finalize');
    }
  }

  /**
   * Query Result_Store for all results matching a batch ID
   * @param {string} batchId - Batch identifier
   * @returns {Promise<Array>} Array of result objects
   */
  async _queryResultsByBatchId(batchId) {
    try {
      const { RESULT_CACHE, KEY_PATTERNS } = require('../redis/keys');
      
      // Scan for all result keys
      const resultKeys = [];
      let cursor = '0';
      
      do {
        const [newCursor, keys] = await this.redis.scan(cursor, 'MATCH', KEY_PATTERNS.allResults, 'COUNT', 100);
        cursor = newCursor;
        resultKeys.push(...keys);
      } while (cursor !== '0');
      
      if (resultKeys.length === 0) {
        return [];
      }
      
      // Get all result data
      const resultData = await this.redis.mget(resultKeys);
      const results = [];
      
      for (let i = 0; i < resultKeys.length; i++) {
        const data = resultData[i];
        if (!data) continue;
        
        try {
          const result = JSON.parse(data);
          
          // Filter by batchId if present in result
          if (result.batchId === batchId) {
            results.push(result);
          }
        } catch (parseError) {
          this.logger.warn('Failed to parse result data', {
            key: resultKeys[i],
            error: parseError.message
          });
        }
      }
      
      return results;
      
    } catch (error) {
      this.logger.error('Failed to query results by batch ID', {
        batchId,
        error: error.message
      });
      return [];
    }
  }

  /**
   * Format summary message for Telegram
   * @param {Object} data - Summary data
   * @returns {string} Formatted message
   */
  _formatSummaryMessage({ batchId, total, counts, validCredentials, elapsed }) {
    const { escapeV2, codeV2, boldV2, spoilerCodeV2 } = require('../../telegram/messages/helpers');
    
    const elapsedSeconds = Math.floor(elapsed / 1000);
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    const remainingSeconds = elapsedSeconds % 60;
    
    const elapsedStr = elapsedMinutes > 0 
      ? `${elapsedMinutes}m ${remainingSeconds}s`
      : `${elapsedSeconds}s`;
    
    const parts = [];
    
    // Header
    parts.push(`📊 ${boldV2('BATCH COMPLETE')}`);
    parts.push('');
    
    // Statistics
    parts.push(boldV2('📈 Statistics'));
    parts.push(`├ ${escapeV2('Batch ID:')} ${codeV2(batchId)}`);
    parts.push(`├ ${escapeV2('Total:')} ${codeV2(String(total))}`);
    parts.push(`└ ${escapeV2('Time:')} ${codeV2(elapsedStr)}`);
    parts.push('');
    
    // Results
    parts.push(boldV2('📋 Results'));
    parts.push(`├ ✅ ${escapeV2('Valid:')} ${codeV2(String(counts.VALID || 0))}`);
    parts.push(`├ ❌ ${escapeV2('Invalid:')} ${codeV2(String(counts.INVALID || 0))}`);
    parts.push(`├ 🔒 ${escapeV2('Blocked:')} ${codeV2(String(counts.BLOCKED || 0))}`);
    parts.push(`└ ⚠️ ${escapeV2('Error:')} ${codeV2(String(counts.ERROR || 0))}`);
    
    // Valid credentials in spoiler format with IP addresses
    if (validCredentials && validCredentials.length > 0) {
      parts.push('');
      parts.push(boldV2('🔐 Valid Credentials'));
      
      validCredentials.forEach((cred, i) => {
        const prefix = i === validCredentials.length - 1 ? '└' : '├';
        const credStr = `${cred.username}:${cred.password}`;
        const ipStr = cred.ipAddress !== 'Unknown' ? ` 🌐 ${cred.ipAddress}` : '';
        
        // Use spoiler format for credentials
        parts.push(`${prefix} ${spoilerCodeV2(credStr)}${escapeV2(ipStr)}`);
      });
    }
    
    return parts.join('\n');
  }

  /**
   * Calculate estimated time remaining
   * @param {number} startTime - Batch start timestamp
   * @param {number} completed - Completed tasks
   * @param {number} total - Total tasks
   * @returns {number} Estimated time remaining in milliseconds
   */
  _calculateETA(startTime, completed, total) {
    if (completed === 0) return null;
    
    const elapsed = Date.now() - startTime;
    const rate = completed / elapsed; // tasks per millisecond
    const remaining = total - completed;
    
    return remaining / rate;
  }

  /**
   * Calculate throughput (tasks per minute)
   * @param {number} startTime - Batch start timestamp
   * @param {number} completed - Completed tasks
   * @returns {number} Tasks per minute
   */
  _calculateThroughput(startTime, completed) {
    if (completed === 0) return 0;
    
    const elapsed = Date.now() - startTime;
    const minutes = elapsed / 60000; // Convert to minutes
    
    return completed / minutes;
  }

  /**
   * Clean up progress tracker data
   * @param {string} batchId - Batch identifier
   * @returns {Promise<void>}
   */
  async cleanup(batchId) {
    try {
      // Remove from Redis
      const key = PROGRESS_TRACKER.generate(batchId);
      const counterKey = PROGRESS_TRACKER.generateCounter(batchId);
      const countsKey = PROGRESS_TRACKER.generateCounts(batchId);
      const validCredsKey = PROGRESS_TRACKER.generateValidCreds(batchId);
      
      await Promise.all([
        this.redis.executeCommand('del', key),
        this.redis.executeCommand('del', counterKey),
        this.redis.executeCommand('del', countsKey),
        this.redis.executeCommand('del', validCredsKey)
      ]);
      
      // Remove from local caches
      this.activeTrackers.delete(batchId);
      this.updateTimers.delete(batchId);
      
      // Stop polling if no more active batches
      if (this.activeTrackers.size === 0) {
        this.stopProgressPolling();
      }
      
      this.logger.info('Progress tracker cleaned up', { batchId });
      
    } catch (error) {
      this.logger.error('Failed to cleanup progress tracker', {
        batchId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Start tracking progress for a batch with polling
   * @param {string} batchId - Batch identifier  
   * @param {string} filename - Batch filename for display
   * @returns {void}
   */
  startTracking(batchId, filename) {
    this.logger.info('Started progress tracking with polling', { batchId, filename });
    
    // Store filename in tracker data
    const data = this.activeTrackers.get(batchId);
    if (data) {
      data.filename = filename;
      this.activeTrackers.set(batchId, data);
    }
    
    // Start polling interval for this batch (every 1.5 seconds for more responsive updates)
    const pollInterval = setInterval(async () => {
      try {
        const progressData = this.activeTrackers.get(batchId);
        if (!progressData) {
          clearInterval(pollInterval);
          return;
        }
        
        // Check if batch is complete or aborted
        if (progressData.aborted || progressData.completed >= progressData.total) {
          clearInterval(pollInterval);
          this.logger.info('Polling stopped - batch complete or aborted', { batchId });
          
          // If batch is complete (not aborted), send summary
          if (!progressData.aborted && progressData.completed >= progressData.total) {
            this.logger.info('Batch completed, sending summary', { batchId });
            try {
              await this.sendSummary(batchId);
            } catch (error) {
              this.logger.error('Failed to send completion summary', { 
                batchId, 
                error: error.message 
              });
            }
          }
          
          return;
        }
        
        // Trigger progress update
        await this.handleProgressUpdate(batchId);
        
      } catch (error) {
        this.logger.warn('Progress polling error', { batchId, error: error.message });
      }
    }, this.throttleMs); // Align polling interval to throttle to avoid 429s
    
    // Store interval reference for cleanup
    if (!this.pollingIntervals) {
      this.pollingIntervals = new Map();
    }
    this.pollingIntervals.set(batchId, pollInterval);
  }

  /**
   * Get active batches for a specific chat
   * @param {number} chatId - Telegram chat ID
   * @returns {Promise<Array<string>>} Array of batch IDs
   */
  async getActiveBatchesForChat(chatId) {
    const batches = [];
    for (const [batchId, data] of this.activeTrackers.entries()) {
      if (data.chatId === chatId && data.completed < data.total) {
        batches.push(batchId);
      }
    }
    return batches;
  }

  /**
   * Abort a batch
   * @param {string} batchId - Batch identifier
   * @returns {Promise<void>}
   */
  async abortBatch(batchId) {
    try {
      // Mark batch as aborted in Redis
      const key = PROGRESS_TRACKER.generate(batchId);
      const data = await this.getProgressData(batchId);
      
      if (data) {
        data.aborted = true;
        data.abortedAt = Date.now();
        await this.redis.executeCommand('setex', key, PROGRESS_TRACKER.ttl, JSON.stringify(data));
        
        // Update local cache
        this.activeTrackers.set(batchId, data);
        
        // Send aborted message to Telegram
        await this.sendAbortedMessage(batchId);
        
        this.logger.info('Batch aborted', { batchId });
      }
    } catch (error) {
      this.logger.error('Failed to abort batch', {
        batchId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Send aborted message to Telegram
   * @param {string} batchId - Batch identifier
   * @returns {Promise<void>}
   */
  async sendAbortedMessage(batchId) {
    let progressData;

    try {
      progressData = await this.getProgressData(batchId);
      if (!progressData) {
        this.logger.warn('Cannot send aborted message for unknown batch', { batchId });
        await this._cleanupSilently(batchId, 'sendAborted:missing');
        return;
      }

      // If Telegram client is not ready (e.g., during crash recovery), skip edits but still clean up
      if (!this.telegram) {
        this.logger.warn('Telegram client unavailable during sendAbortedMessage, skipping edit', { batchId });
        await this._cleanupSilently(batchId, 'sendAborted:no-telegram');
        return;
      }
      
      // Get current counts and valid credentials from Redis
      const countsKey = PROGRESS_TRACKER.generateCounts(batchId);
      const countsData = await this.redis.executeCommand('hgetall', countsKey);
      const counts = {
        VALID: parseInt(countsData.VALID) || 0,
        INVALID: parseInt(countsData.INVALID) || 0,
        BLOCKED: parseInt(countsData.BLOCKED) || 0,
        ERROR: parseInt(countsData.ERROR) || 0
      };
      
      const validCredsKey = PROGRESS_TRACKER.generateValidCreds(batchId);
      const validCredsData = await this.redis.executeCommand('lrange', validCredsKey, 0, -1);
      const validCreds = validCredsData.map(data => {
        try {
          return JSON.parse(data);
        } catch (e) {
          return null;
        }
      }).filter(Boolean);
      
      // Use the same aborted message format as single-node mode
      const { buildBatchAborted } = require('../../telegram/messages');
      const abortedMessage = buildBatchAborted({
        filename: progressData.filename,
        total: progressData.total,
        processed: progressData.completed,
        counts,
        validCreds
      });
      
      // Edit the progress message to show aborted status
      await this.telegram.editMessageText(
        progressData.chatId,
        progressData.messageId,
        undefined,
        abortedMessage,
        { parse_mode: 'MarkdownV2' }
      );
      
      this.logger.info('Batch aborted message sent', {
        batchId,
        processed: progressData.completed,
        total: progressData.total,
        validCount: validCreds.length
      });
      
    } catch (error) {
      this.logger.error('Failed to send aborted message', {
        batchId,
        error: error.message
      });
    } finally {
      await this._cleanupSilently(batchId, 'sendAborted:finalize');
    }
  }

  /**
   * Cleanup helper that never throws, used to stop polling even when Telegram errors.
   * @param {string} batchId
   * @param {string} context
   * @returns {Promise<void>}
   */
  async _cleanupSilently(batchId, context = 'unknown') {
    try {
      await this.cleanup(batchId);
    } catch (cleanupError) {
      this.logger.error('Failed to cleanup progress tracker', {
        batchId,
        context,
        error: cleanupError.message
      });
    }
  }
}

module.exports = ProgressTracker;