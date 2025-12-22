/**
 * Single Node Mode Compatibility Layer
 * 
 * Provides backward compatibility for single-node deployment when Redis is not available.
 * Falls back to in-memory job queue and existing processedStore.js for deduplication.
 * 
 * Requirements: 9.2, 9.3
 */

const { createLogger } = require('../../logger');
const { initProcessedStore, getProcessedStatusBatch, markProcessedStatus } = require('../../automation/batch/processedStore');

const log = createLogger('single-node-mode');

class SingleNodeJobQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.workers = new Map(); // workerId -> worker function
    this.batchProgress = new Map(); // batchId -> { total, completed, chatId, messageId }
    this.results = new Map(); // credential key -> result
    this.concurrency = parseInt(process.env.BATCH_CONCURRENCY, 10) || 1;
    
    log.warn('Running in single-node mode - Redis not available');
    log.info('Using in-memory job queue and existing processedStore for deduplication');
  }

  /**
   * Enqueue a batch of credentials for processing
   * @param {string} batchId - Unique batch identifier
   * @param {Array<{username, password}>} credentials - Credentials to check
   * @param {Object} options - Batch options
   * @returns {Promise<{queued: number, cached: number}>}
   */
  async enqueueBatch(batchId, credentials, options = {}) {
    try {
      log.info(`Enqueueing batch ${batchId} with ${credentials.length} credentials`);
      
      // Initialize processed store (will use JSONL backend)
      await initProcessedStore();
      
      // Check for already-processed credentials using existing processedStore
      const credentialKeys = credentials.map(cred => `${cred.username}:${cred.password}`);
      const statusMap = await getProcessedStatusBatch(credentialKeys);
      
      // Filter out cached results
      const newCredentials = [];
      let cachedCount = 0;
      
      for (const credential of credentials) {
        const key = `${credential.username}:${credential.password}`;
        const cachedStatus = statusMap.get(key);
        
        if (cachedStatus && ['VALID', 'INVALID', 'BLOCKED'].includes(cachedStatus)) {
          cachedCount++;
          log.debug(`Skipping cached credential: ${credential.username} (${cachedStatus})`);
        } else {
          newCredentials.push({
            taskId: `${batchId}-${newCredentials.length + 1}`,
            batchId,
            username: credential.username,
            password: credential.password,
            proxyUrl: options.proxy || process.env.PROXY_SERVER,
            retryCount: 0,
            createdAt: Date.now(),
            batchType: options.batchType || 'SINGLE'
          });
        }
      }
      
      // Add tasks to in-memory queue
      this.queue.push(...newCredentials);
      
      // Initialize progress tracker
      this.batchProgress.set(batchId, {
        total: credentials.length,
        completed: cachedCount, // Start with cached count
        chatId: options.chatId,
        messageId: options.messageId,
        startTime: Date.now()
      });
      
      log.info(`Batch ${batchId} enqueued: ${newCredentials.length} new, ${cachedCount} cached`);
      
      return {
        queued: newCredentials.length,
        cached: cachedCount
      };
      
    } catch (error) {
      log.error(`Failed to enqueue batch ${batchId}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Start processing the queue
   * @param {Function} taskProcessor - Function to process individual tasks
   * @param {Function} progressCallback - Function to call on progress updates
   */
  async startProcessing(taskProcessor, progressCallback) {
    if (this.processing) {
      log.warn('Queue processing already started');
      return;
    }
    
    this.processing = true;
    log.info(`Starting single-node queue processing with concurrency ${this.concurrency}`);
    
    // Start worker processes
    const workers = [];
    for (let i = 0; i < this.concurrency; i++) {
      workers.push(this.workerLoop(i, taskProcessor, progressCallback));
    }
    
    // Wait for all workers to complete
    await Promise.all(workers);
    
    this.processing = false;
    log.info('Queue processing completed');
  }

  /**
   * Worker loop for processing tasks
   * @param {number} workerId - Worker identifier
   * @param {Function} taskProcessor - Function to process tasks
   * @param {Function} progressCallback - Progress update callback
   */
  async workerLoop(workerId, taskProcessor, progressCallback) {
    log.debug(`Worker ${workerId} started`);
    
    while (this.processing && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) {
        // No more tasks, wait a bit
        await this.sleep(100);
        continue;
      }
      
      try {
        log.debug(`Worker ${workerId} processing task ${task.taskId}`);
        
        // Process the task
        const result = await taskProcessor(task);
        
        // Store result in processedStore
        await markProcessedStatus(
          `${task.username}:${task.password}`,
          result.status
        );
        
        // Update progress
        await this.updateProgress(task.batchId, progressCallback);
        
        log.debug(`Worker ${workerId} completed task ${task.taskId}: ${result.status}`);
        
      } catch (error) {
        log.error(`Worker ${workerId} failed to process task ${task.taskId}`, {
          error: error.message
        });
        
        // Mark as ERROR and update progress
        await markProcessedStatus(
          `${task.username}:${task.password}`,
          'ERROR'
        );
        
        await this.updateProgress(task.batchId, progressCallback);
      }
    }
    
    log.debug(`Worker ${workerId} finished`);
  }

  /**
   * Update progress for a batch
   * @param {string} batchId - Batch identifier
   * @param {Function} progressCallback - Progress callback function
   */
  async updateProgress(batchId, progressCallback) {
    const progress = this.batchProgress.get(batchId);
    if (!progress) return;
    
    progress.completed++;
    
    // Call progress callback with throttling (max once per 3 seconds)
    const now = Date.now();
    if (!progress.lastUpdate || (now - progress.lastUpdate) >= 3000) {
      progress.lastUpdate = now;
      
      if (progressCallback) {
        try {
          await progressCallback(batchId, progress);
        } catch (error) {
          log.error(`Progress callback failed for batch ${batchId}`, {
            error: error.message
          });
        }
      }
    }
    
    // Check if batch is complete
    if (progress.completed >= progress.total) {
      log.info(`Batch ${batchId} completed: ${progress.completed}/${progress.total}`);
      
      // Final progress update
      if (progressCallback) {
        try {
          await progressCallback(batchId, { ...progress, completed: progress.total });
        } catch (error) {
          log.error(`Final progress callback failed for batch ${batchId}`, {
            error: error.message
          });
        }
      }
      
      // Clean up
      this.batchProgress.delete(batchId);
    }
  }

  /**
   * Cancel a batch
   * @param {string} batchId - Batch to cancel
   * @returns {Promise<{drained: number}>}
   */
  async cancelBatch(batchId) {
    const initialLength = this.queue.length;
    
    // Remove all tasks for this batch from queue
    this.queue = this.queue.filter(task => task.batchId !== batchId);
    
    const drained = initialLength - this.queue.length;
    
    // Clean up progress tracking
    this.batchProgress.delete(batchId);
    
    log.info(`Cancelled batch ${batchId}, drained ${drained} tasks`);
    
    return { drained };
  }

  /**
   * Get queue statistics
   * @returns {Object} Queue stats
   */
  getQueueStats() {
    return {
      mainQueue: this.queue.length,
      retryQueue: 0, // No retry queue in single-node mode
      total: this.queue.length,
      processing: this.processing,
      activeBatches: this.batchProgress.size
    };
  }

  /**
   * Check if batch exists
   * @param {string} batchId - Batch identifier
   * @returns {boolean}
   */
  batchExists(batchId) {
    return this.batchProgress.has(batchId);
  }

  /**
   * Sleep utility
   * @param {number} ms - Milliseconds to sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Stop processing
   */
  stop() {
    this.processing = false;
    log.info('Single-node queue processing stopped');
  }
}

/**
 * Single-node mode detector and factory
 */
class SingleNodeMode {
  constructor() {
    this.isActive = false;
    this.jobQueue = null;
  }

  /**
   * Detect if running in single-node mode
   * @returns {boolean} True if Redis is not available
   */
  static detect() {
    const redisUrl = process.env.REDIS_URL;
    const isDistributed = Boolean(redisUrl);
    
    if (!isDistributed) {
      log.warn('REDIS_URL not set - running in single-node mode');
      log.info('Single-node mode features:');
      log.info('  - In-memory job queue');
      log.info('  - JSONL-based deduplication cache');
      log.info('  - Existing Telegram bot functionality');
      log.info('  - No distributed workers');
      return true;
    }
    
    return false;
  }

  /**
   * Initialize single-node mode
   * @returns {SingleNodeJobQueue} Job queue instance
   */
  static initialize() {
    if (!SingleNodeMode.detect()) {
      throw new Error('Cannot initialize single-node mode when Redis is available');
    }
    
    const jobQueue = new SingleNodeJobQueue();
    
    log.info('Single-node mode initialized successfully');
    
    return jobQueue;
  }

  /**
   * Create a compatibility wrapper for distributed components
   * @returns {Object} Mock distributed components
   */
  static createCompatibilityWrapper() {
    const jobQueue = SingleNodeMode.initialize();
    
    return {
      jobQueue,
      
      // Mock coordinator for compatibility
      coordinator: {
        submitBatch: async (batchId, credentials, options) => {
          return await jobQueue.enqueueBatch(batchId, credentials, options);
        },
        
        cancelBatch: async (batchId) => {
          return await jobQueue.cancelBatch(batchId);
        },
        
        getSystemStatus: async () => {
          return {
            coordinator: {
              id: 'single-node',
              uptime: Date.now() - process.uptime() * 1000,
              running: true
            },
            queue: jobQueue.getQueueStats(),
            workers: {
              active: jobQueue.concurrency,
              details: []
            },
            proxies: {
              total: process.env.PROXY_SERVER ? 1 : 0,
              healthy: process.env.PROXY_SERVER ? 1 : 0,
              details: []
            }
          };
        },
        
        formatSystemStatus: (status) => {
          const { escapeV2, codeV2, boldV2 } = require('../../telegram/messages/helpers');
          
          return [
            `📊 ${boldV2('SYSTEM STATUS')}`,
            '',
            boldV2('🎛️ Mode'),
            `└ ${codeV2('Single-Node (Legacy)')}`,
            '',
            boldV2('📋 Job Queue'),
            `├ Queue: ${codeV2(String(status.queue.total))}`,
            `└ Processing: ${status.queue.processing ? '🟢 Active' : '🔴 Idle'}`,
            '',
            boldV2('👷 Workers'),
            `└ Concurrency: ${codeV2(String(status.workers.active))}`,
            '',
            boldV2('🌐 Proxy'),
            `└ ${status.proxies.total > 0 ? codeV2('Configured') : escapeV2('Direct connections')}`
          ].join('\n');
        }
      },
      
      // Mock progress tracker
      progressTracker: {
        initBatch: async (batchId, total, chatId, messageId) => {
          // Handled by jobQueue
        },
        
        handleProgressUpdate: async (batchId) => {
          // Handled by jobQueue
        },
        
        sendSummary: async (batchId) => {
          // Will be handled by the existing batch completion logic
        }
      },
      
      // Mock channel forwarder
      channelForwarder: {
        start: async () => {
          // No-op in single-node mode
        },
        
        stop: async () => {
          // No-op in single-node mode
        }
      }
    };
  }
}

module.exports = {
  SingleNodeMode,
  SingleNodeJobQueue
};