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
    
    // Throttle interval (3 seconds per batch)
    this.throttleMs = 3000;
  }

  /**
   * Initialize progress tracking for a batch
   * @param {string} batchId - Batch identifier
   * @param {number} totalTasks - Total number of tasks
   * @param {number} chatId - Telegram chat ID
   * @param {number} messageId - Telegram message ID to edit
   * @returns {Promise<void>}
   */
  async initBatch(batchId, totalTasks, chatId, messageId) {
    const progressData = {
      batchId,
      total: totalTasks,
      completed: 0,
      chatId,
      messageId,
      startTime: Date.now()
    };

    try {
      // Store progress tracker in Redis with 7-day TTL
      const key = PROGRESS_TRACKER.generate(batchId);
      await this.redis.setex(key, PROGRESS_TRACKER.ttl, JSON.stringify(progressData));
      
      // Initialize progress counter to 0
      const counterKey = PROGRESS_TRACKER.generateCounter(batchId);
      await this.redis.set(counterKey, 0);
      await this.redis.expire(counterKey, PROGRESS_TRACKER.ttl);
      
      // Store in local cache for fast access
      this.activeTrackers.set(batchId, progressData);
      
      // Initialize throttle timer
      this.updateTimers.set(batchId, 0);
      
      this.logger.info('Progress tracker initialized', {
        batchId,
        totalTasks,
        chatId,
        messageId
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
      const data = await this.redis.get(key);
      
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
   * Implements 3-second throttling per batch to prevent Telegram rate limiting
   * @param {string} batchId - Batch identifier
   * @returns {Promise<void>}
   */
  async handleProgressUpdate(batchId) {
    try {
      // Check throttling - skip if less than 3 seconds since last update
      const now = Date.now();
      const lastUpdate = this.updateTimers.get(batchId) || 0;
      
      if (now - lastUpdate < this.throttleMs) {
        this.logger.debug('Progress update throttled', {
          batchId,
          timeSinceLastUpdate: now - lastUpdate,
          throttleMs: this.throttleMs
        });
        return;
      }
      
      // Get progress data
      const progressData = await this.getProgressData(batchId);
      if (!progressData) {
        this.logger.warn('Progress update for unknown batch', { batchId });
        return;
      }
      
      // Fetch current completed count from Redis
      const counterKey = PROGRESS_TRACKER.generateCounter(batchId);
      const completedStr = await this.redis.get(counterKey);
      const completed = parseInt(completedStr) || 0;
      
      // Calculate percentage
      const percentage = progressData.total > 0 ? Math.round((completed / progressData.total) * 100) : 0;
      
      // Update local cache
      progressData.completed = completed;
      this.activeTrackers.set(batchId, progressData);
      
      // Create progress bar (10 characters)
      const filledBars = Math.floor(percentage / 10);
      const progressBar = '█'.repeat(filledBars) + '░'.repeat(10 - filledBars);
      
      // Format progress message
      const progressMessage = this._formatProgressMessage({
        batchId,
        completed,
        total: progressData.total,
        percentage,
        progressBar,
        startTime: progressData.startTime
      });
      
      // Edit Telegram message
      await this.telegram.editMessageText(
        progressData.chatId,
        progressData.messageId,
        undefined,
        progressMessage,
        { parse_mode: 'MarkdownV2' }
      );
      
      // Update throttle timer
      this.updateTimers.set(batchId, now);
      
      // Log structured batch progress
      this.logger.logBatchProgress({
        batchId,
        total: progressData.total,
        completed,
        percentage,
        estimatedTimeRemaining: this._calculateETA(progressData.startTime, completed, progressData.total),
        throughput: this._calculateThroughput(progressData.startTime, completed)
      });
      
      this.logger.debug('Progress update sent', {
        batchId,
        completed,
        total: progressData.total,
        percentage
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
   * @returns {Promise<void>}
   */
  async subscribeToProgressEvents() {
    try {
      // Subscribe to worker heartbeats channel for progress updates
      await this.redis.subscribe(PUBSUB_CHANNELS.workerHeartbeats);
      
      this.redis.on('message', async (channel, message) => {
        if (channel === PUBSUB_CHANNELS.workerHeartbeats) {
          try {
            const { batchId } = JSON.parse(message);
            if (batchId && this.activeTrackers.has(batchId)) {
              await this.handleProgressUpdate(batchId);
            }
          } catch (parseError) {
            this.logger.warn('Failed to parse worker heartbeat message', {
              channel,
              message,
              error: parseError.message
            });
          }
        }
      });
      
      this.logger.info('Subscribed to progress events');
      
    } catch (error) {
      this.logger.error('Failed to subscribe to progress events', {
        error: error.message,
        stack: error.stack
      });
      throw error;
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
    try {
      // Get progress data
      const progressData = await this.getProgressData(batchId);
      if (!progressData) {
        this.logger.warn('Cannot send summary for unknown batch', { batchId });
        return;
      }
      
      // Query Result_Store for all results matching batchId
      const results = await this._queryResultsByBatchId(batchId);
      
      // Aggregate counts by status
      const counts = {
        VALID: 0,
        INVALID: 0,
        BLOCKED: 0,
        ERROR: 0
      };
      
      const validCredentials = [];
      
      for (const result of results) {
        const status = result.status || 'ERROR';
        counts[status] = (counts[status] || 0) + 1;
        
        // Collect VALID credentials with IP addresses
        if (status === 'VALID') {
          validCredentials.push({
            username: result.username,
            password: result.password,
            ipAddress: result.ipAddress || 'Unknown'
          });
        }
      }
      
      // Calculate elapsed time
      const elapsed = Date.now() - progressData.startTime;
      
      // Format summary message
      const summaryMessage = this._formatSummaryMessage({
        batchId,
        total: progressData.total,
        counts,
        validCredentials,
        elapsed
      });
      
      // Send summary message to Telegram
      await this.telegram.sendMessage(
        progressData.chatId,
        summaryMessage,
        { parse_mode: 'MarkdownV2' }
      );
      
      this.logger.info('Batch summary sent', {
        batchId,
        total: progressData.total,
        counts,
        validCount: validCredentials.length,
        elapsed
      });
      
      // Clean up progress tracker
      await this.cleanup(batchId);
      
    } catch (error) {
      this.logger.error('Failed to send batch summary', {
        batchId,
        error: error.message,
        stack: error.stack
      });
      throw error;
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
      
      await Promise.all([
        this.redis.del(key),
        this.redis.del(counterKey)
      ]);
      
      // Remove from local caches
      this.activeTrackers.delete(batchId);
      this.updateTimers.delete(batchId);
      
      this.logger.info('Progress tracker cleaned up', { batchId });
      
    } catch (error) {
      this.logger.error('Failed to cleanup progress tracker', {
        batchId,
        error: error.message
      });
      throw error;
    }
  }
}

module.exports = ProgressTracker;