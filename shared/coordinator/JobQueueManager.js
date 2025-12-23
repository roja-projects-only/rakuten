/**
 * Job Queue Manager - Coordinator Component
 * 
 * Orchestrates batch processing by splitting credentials into individual tasks
 * and managing the Redis-based job queue with deduplication and retry logic.
 * 
 * Requirements: 1.1, 1.2, 1.5, 1.8, 1.9, 5.6, 7.1, 7.2
 */

const { createLogger } = require('../../logger');
const { 
  JOB_QUEUE, 
  RESULT_CACHE, 
  PROGRESS_TRACKER,
  generateTaskId 
} = require('../redis/keys');

const log = createLogger('job-queue-manager');

class JobQueueManager {
  constructor(redisClient, proxyPoolManager) {
    this.redis = redisClient;
    this.proxyPool = proxyPoolManager;
    this.maxRetries = parseInt(process.env.BATCH_MAX_RETRIES, 10) || 2;
    this.errorExclusionTtl = 24 * 60 * 60; // 24 hours in seconds
  }

  /**
   * Enqueue a batch of credentials for processing (optimized for large batches)
   * @param {string} batchId - Unique batch identifier
   * @param {Array<{username, password}>} credentials - Credentials to check
   * @param {Object} options - Batch options (type, retries, etc.)
   * @returns {Promise<{queued: number, cached: number}>}
   */
  async enqueueBatch(batchId, credentials, options = {}) {
    log.info(`Enqueuing batch ${batchId} with ${credentials.length} credentials`, {
      batchId,
      credentialCount: credentials.length,
      batchType: options.batchType || 'UNKNOWN'
    });

    // 1. Query Result_Store for already-processed credentials (dedup)
    const credentialKeys = credentials.map(cred => `${cred.username}:${cred.password}`);
    const cachedResults = await this.checkCachedResults(credentialKeys);
    
    // 2. Filter out cached results (within 30 days)
    const newCredentials = [];
    const cachedCredentials = [];
    
    for (let i = 0; i < credentials.length; i++) {
      const credential = credentials[i];
      const key = credentialKeys[i];
      const cachedStatus = cachedResults.get(key);
      
      if (cachedStatus) {
        cachedCredentials.push({ ...credential, cachedStatus });
      } else {
        newCredentials.push(credential);
      }
    }

    log.info(`Deduplication complete: ${newCredentials.length} new, ${cachedCredentials.length} cached`, {
      batchId,
      newCount: newCredentials.length,
      cachedCount: cachedCredentials.length
    });

    // 3. Bulk enqueue tasks in chunks for large batches
    if (newCredentials.length > 0) {
      await this.bulkEnqueueTasks(batchId, newCredentials, options);
      
      log.info(`Enqueued ${newCredentials.length} tasks to Redis queue`, {
        batchId,
        queuedCount: newCredentials.length
      });
    }

    // 4. Initialize progress tracker in Redis
    await this.initializeProgressTracker(batchId, newCredentials.length, options);

    return {
      queued: newCredentials.length,
      cached: cachedCredentials.length,
      cachedCredentials: cachedCredentials
    };
  }

  /**
   * Bulk enqueue tasks in optimized chunks for large batches
   * @param {string} batchId - Batch identifier
   * @param {Array<{username, password}>} credentials - Credentials to enqueue
   * @param {Object} options - Batch options
   */
  async bulkEnqueueTasks(batchId, credentials, options) {
    const CHUNK_SIZE = 1000; // Process 1000 tasks per chunk
    const totalChunks = Math.ceil(credentials.length / CHUNK_SIZE);
    
    log.info(`Bulk enqueuing ${credentials.length} tasks in ${totalChunks} chunks`, {
      batchId,
      totalTasks: credentials.length,
      chunkSize: CHUNK_SIZE,
      totalChunks
    });

    // Pre-generate proxy assignments for better performance
    const proxyAssignments = await this.bulkAssignProxies(credentials.length);

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const startIdx = chunkIndex * CHUNK_SIZE;
      const endIdx = Math.min(startIdx + CHUNK_SIZE, credentials.length);
      const chunk = credentials.slice(startIdx, endIdx);
      
      // Create tasks for this chunk
      const tasks = [];
      for (let i = 0; i < chunk.length; i++) {
        const credential = chunk[i];
        const globalIndex = startIdx + i;
        const taskId = generateTaskId(batchId, globalIndex);
        const proxyAssignment = proxyAssignments[globalIndex];
        
        const task = {
          taskId,
          batchId,
          username: credential.username,
          password: credential.password,
          proxyId: proxyAssignment?.proxyId || null,
          proxyUrl: proxyAssignment?.proxyUrl || null,
          retryCount: 0,
          createdAt: Date.now(),
          batchType: options.batchType || 'UNKNOWN'
        };
        
        tasks.push(task);
      }

      // Bulk serialize and enqueue this chunk
      const taskJsons = tasks.map(task => JSON.stringify(task));
      
      // Use pipeline for better performance
      const pipeline = this.redis.pipeline();
      
      // Split into smaller Redis commands to avoid command size limits
      const REDIS_BATCH_SIZE = 100; // 100 tasks per Redis command
      for (let i = 0; i < taskJsons.length; i += REDIS_BATCH_SIZE) {
        const redisBatch = taskJsons.slice(i, i + REDIS_BATCH_SIZE);
        pipeline.rpush(JOB_QUEUE.tasks, ...redisBatch);
      }
      
      await pipeline.exec();
      
      // Log progress for large batches
      if (totalChunks > 10 && chunkIndex % 10 === 0) {
        log.info(`Enqueue progress: ${chunkIndex + 1}/${totalChunks} chunks (${endIdx}/${credentials.length} tasks)`, {
          batchId,
          chunkIndex: chunkIndex + 1,
          totalChunks,
          tasksEnqueued: endIdx
        });
      }
    }

    log.info(`Bulk enqueue completed for batch ${batchId}`, {
      batchId,
      totalTasks: credentials.length,
      chunksProcessed: totalChunks
    });
  }

  /**
   * Pre-generate proxy assignments in bulk for better performance
   * @param {number} taskCount - Number of tasks to assign proxies for
   * @returns {Promise<Array<{proxyId, proxyUrl}|null>>}
   */
  async bulkAssignProxies(taskCount) {
    // For single proxy setups, we can optimize this
    if (!this.proxyPool || this.proxyPool.proxies?.length <= 1) {
      // Single proxy or no proxy - return same assignment for all
      const singleAssignment = await this.proxyPool?.assignProxy('bulk-assign') || null;
      return new Array(taskCount).fill(singleAssignment);
    }

    // Multiple proxies - use round-robin without individual Redis calls
    const assignments = [];
    for (let i = 0; i < taskCount; i++) {
      // Simple round-robin without health checks for bulk operations
      // Health checks will happen during actual task processing
      const proxyIndex = i % this.proxyPool.proxies.length;
      const proxyUrl = this.proxyPool.proxies[proxyIndex];
      const proxyId = this.proxyPool._generateProxyId(proxyIndex);
      
      assignments.push({
        proxyId,
        proxyUrl
      });
    }
    
    return assignments;
  }

  /**
   * Check Redis Result_Store for cached credential results
   * @param {Array<string>} credentialKeys - Array of "username:password" keys
   * @returns {Promise<Map<string, string|null>>} Map of key -> status
   */
  async checkCachedResults(credentialKeys) {
    const results = new Map();
    
    if (credentialKeys.length === 0) {
      return results;
    }

    try {
      // Use batch lookup for efficiency - check all possible status keys
      const STATUSES = ['VALID', 'INVALID', 'BLOCKED', 'ERROR'];
      const BATCH_SIZE = 1000; // Increased batch size for better performance
      
      log.debug(`Checking ${credentialKeys.length} credentials for cached results`);
      
      let totalCachedFound = 0;
      
      for (let i = 0; i < credentialKeys.length; i += BATCH_SIZE) {
        const batch = credentialKeys.slice(i, i + BATCH_SIZE);
        
        // Build all possible Redis keys for this batch
        const redisKeys = [];
        const keyIndexMap = []; // Maps redis key index to [credKey, status]
        
        for (const credKey of batch) {
          for (const status of STATUSES) {
            redisKeys.push(RESULT_CACHE.generate(status, ...credKey.split(':')));
            keyIndexMap.push({ credKey, status });
          }
        }
        
        log.debug(`Batch ${Math.floor(i/BATCH_SIZE) + 1}: Checking ${redisKeys.length} Redis keys for ${batch.length} credentials`);
        
        const values = await this.redis.executeCommand('mget', ...redisKeys);
        
        // Process results - find first matching status for each credential
        const foundStatus = new Map();
        let batchCachedCount = 0;
        
        for (let j = 0; j < values.length; j++) {
          if (values[j] && !foundStatus.has(keyIndexMap[j].credKey)) {
            foundStatus.set(keyIndexMap[j].credKey, keyIndexMap[j].status);
            batchCachedCount++;
            
            // Log first few found results for debugging
            if (batchCachedCount <= 3) {
              log.debug(`Found cached result: ${keyIndexMap[j].credKey} -> ${keyIndexMap[j].status}`);
            }
          }
        }
        
        totalCachedFound += batchCachedCount;
        log.debug(`Batch ${Math.floor(i/BATCH_SIZE) + 1}: Found ${batchCachedCount} cached results`);
        
        // Set results for this batch
        for (const credKey of batch) {
          results.set(credKey, foundStatus.get(credKey) || null);
        }
      }
      
      log.info(`Deduplication check complete: ${totalCachedFound} cached results found out of ${credentialKeys.length} credentials`, {
        cachedCount: totalCachedFound,
        totalCount: credentialKeys.length,
        newCount: credentialKeys.length - totalCachedFound
      });
      
    } catch (error) {
      log.error('Error checking cached results', { 
        error: error.message,
        credentialCount: credentialKeys.length 
      });
      // Return empty results on error - will process all credentials
    }
    
    return results;
  }

  /**
   * Initialize progress tracker for a batch
   * @param {string} batchId - Batch identifier
   * @param {number} totalTasks - Total number of tasks to process
   * @param {Object} options - Batch options containing chatId, messageId
   */
  async initializeProgressTracker(batchId, totalTasks, options) {
    const progressData = {
      batchId,
      total: totalTasks,
      completed: 0,
      chatId: options.chatId,
      messageId: options.messageId,
      startTime: Date.now(),
      batchType: options.batchType || 'UNKNOWN'
    };

    try {
      // Store progress tracker data
      await this.redis.executeCommand(
        'setex',
        PROGRESS_TRACKER.generate(batchId),
        PROGRESS_TRACKER.ttl,
        JSON.stringify(progressData)
      );

      // Initialize progress counter
      await this.redis.executeCommand(
        'setex',
        PROGRESS_TRACKER.generateCounter(batchId),
        PROGRESS_TRACKER.ttl,
        '0'
      );

      log.info(`Initialized progress tracker for batch ${batchId}`, {
        batchId,
        totalTasks,
        chatId: options.chatId,
        messageId: options.messageId
      });
    } catch (error) {
      log.error('Error initializing progress tracker', {
        batchId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Re-enqueue a failed task for retry
   * @param {Object} task - Original task object
   * @param {string} errorCode - Error code from failure
   * @returns {Promise<boolean>} - True if re-enqueued, false if max retries exceeded
   */
  async retryTask(task, errorCode) {
    log.info(`Retrying task ${task.taskId} (attempt ${task.retryCount + 1}/${this.maxRetries})`, {
      taskId: task.taskId,
      batchId: task.batchId,
      retryCount: task.retryCount,
      errorCode
    });

    // 1. Check if task.retryCount < MAX_RETRIES
    if (task.retryCount >= this.maxRetries) {
      // 2. If exceeded, mark as ERROR in Result_Store with 24hr exclusion
      await this.markTaskAsError(task, errorCode);
      
      log.warn(`Task ${task.taskId} exceeded max retries (${this.maxRetries}), marked as ERROR`, {
        taskId: task.taskId,
        batchId: task.batchId,
        finalErrorCode: errorCode
      });
      
      return false;
    }

    // 3. If retryable, increment retryCount, preserve proxy assignment
    const retryTask = {
      ...task,
      retryCount: task.retryCount + 1,
      lastErrorCode: errorCode,
      retryAt: Date.now()
    };

    // 4. RPUSH to retry queue (higher priority than main queue)
    try {
      await this.redis.executeCommand('rpush', JOB_QUEUE.retry, JSON.stringify(retryTask));
      
      log.info(`Task ${task.taskId} re-enqueued for retry`, {
        taskId: task.taskId,
        batchId: task.batchId,
        retryCount: retryTask.retryCount,
        proxyId: task.proxyId // Preserved proxy assignment
      });
      
      return true;
    } catch (error) {
      log.error('Error re-enqueuing task for retry', {
        taskId: task.taskId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Mark a task as ERROR in Result_Store with 24-hour exclusion
   * @param {Object} task - Task object
   * @param {string} errorCode - Final error code
   */
  async markTaskAsError(task, errorCode) {
    try {
      const resultKey = RESULT_CACHE.generate('ERROR', task.username, task.password);
      const resultData = JSON.stringify({
        username: task.username,
        password: task.password,
        status: 'ERROR',
        errorCode: errorCode,
        checkedAt: Date.now(),
        retryCount: task.retryCount,
        batchId: task.batchId,
        taskId: task.taskId
      });

      // Store with 24-hour TTL for exclusion
      await this.redis.executeCommand('setex', resultKey, this.errorExclusionTtl, resultData);
      
      log.debug(`Marked task ${task.taskId} as ERROR in Result_Store`, {
        taskId: task.taskId,
        username: task.username,
        errorCode,
        exclusionTtl: this.errorExclusionTtl
      });
    } catch (error) {
      log.error('Error marking task as ERROR', {
        taskId: task.taskId,
        error: error.message
      });
    }
  }

  /**
   * Cancel a batch and drain remaining tasks
   * @param {string} batchId - Batch to cancel
   * @returns {Promise<{drained: number}>}
   */
  async cancelBatch(batchId) {
    log.info(`Cancelling batch ${batchId}`, { batchId });

    let drainedCount = 0;

    try {
      // 1. Mark batch as cancelled in Redis
      const cancelKey = `batch:${batchId}:cancelled`;
      await this.redis.executeCommand('setex', cancelKey, 3600, Date.now().toString()); // 1 hour TTL

      // 2. Remove all tasks matching batchId from both queues
      drainedCount += await this.drainQueueByBatchId(JOB_QUEUE.tasks, batchId);
      drainedCount += await this.drainQueueByBatchId(JOB_QUEUE.retry, batchId);

      log.info(`Batch ${batchId} cancelled, drained ${drainedCount} tasks`, {
        batchId,
        drainedCount
      });

      return { drained: drainedCount };
    } catch (error) {
      log.error('Error cancelling batch', {
        batchId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Drain tasks from a specific queue by batchId (optimized for bulk operations)
   * @param {string} queueName - Queue name to drain from
   * @param {string} batchId - Batch ID to match
   * @returns {Promise<number>} - Number of tasks drained
   */
  async drainQueueByBatchId(queueName, batchId) {
    let drainedCount = 0;
    const tempQueue = `${queueName}:temp:${Date.now()}`;

    try {
      // Get queue length first to optimize bulk operations
      const queueLength = await this.redis.executeCommand('llen', queueName);
      
      if (queueLength === 0) {
        log.debug(`Queue ${queueName} is empty, nothing to drain`);
        return 0;
      }

      log.info(`Draining batch ${batchId} from ${queueName} (${queueLength} tasks to check)`);

      // Use LRANGE to get all tasks at once instead of LPOP loop
      const allTasks = await this.redis.executeCommand('lrange', queueName, 0, -1);
      
      if (allTasks.length === 0) {
        return 0;
      }

      // Filter tasks in memory (much faster than Redis operations)
      const tasksToKeep = [];
      const tasksToRemove = [];

      for (const task of allTasks) {
        try {
          const taskObj = JSON.parse(task);
          if (taskObj.batchId === batchId) {
            tasksToRemove.push(taskObj);
            drainedCount++;
          } else {
            tasksToKeep.push(task);
          }
        } catch (parseError) {
          log.warn('Error parsing task during drain, keeping task', {
            error: parseError.message,
            task: task.substring(0, 100) // Log first 100 chars
          });
          tasksToKeep.push(task); // Keep unparseable tasks to avoid data loss
        }
      }

      // Use atomic operations to replace the queue
      const pipeline = this.redis.pipeline();
      
      // Clear the original queue
      pipeline.del(queueName);
      
      // Add back the tasks we want to keep (if any)
      if (tasksToKeep.length > 0) {
        pipeline.rpush(queueName, ...tasksToKeep);
      }
      
      // Execute pipeline atomically
      await pipeline.exec();

      if (drainedCount > 0) {
        log.info(`Drained ${drainedCount} tasks from ${queueName} for batch ${batchId}`, {
          batchId,
          drainedCount,
          remainingTasks: tasksToKeep.length
        });
      }

    } catch (error) {
      log.error('Error draining queue by batchId', {
        queueName,
        batchId,
        error: error.message
      });
      
      // Try to clean up temp queue on error (if it was created)
      try {
        await this.redis.executeCommand('del', tempQueue);
      } catch (cleanupError) {
        log.warn('Error cleaning up temp queue', { 
          tempQueue, 
          error: cleanupError.message 
        });
      }
      
      throw error;
    }

    return drainedCount;
  }

  /**
   * Get queue statistics
   * @returns {Promise<Object>} Queue depth and statistics
   */
  async getQueueStats() {
    try {
      const [tasksLength, retryLength] = await Promise.all([
        this.redis.executeCommand('llen', JOB_QUEUE.tasks),
        this.redis.executeCommand('llen', JOB_QUEUE.retry)
      ]);

      return {
        mainQueue: tasksLength || 0,
        retryQueue: retryLength || 0,
        total: (tasksLength || 0) + (retryLength || 0)
      };
    } catch (error) {
      log.error('Error getting queue stats', { error: error.message });
      return { mainQueue: 0, retryQueue: 0, total: 0 };
    }
  }

  /**
   * Check if a batch is cancelled
   * @param {string} batchId - Batch ID to check
   * @returns {Promise<boolean>} True if batch is cancelled
   */
  async isBatchCancelled(batchId) {
    try {
      const cancelKey = `batch:${batchId}:cancelled`;
      const result = await this.redis.executeCommand('get', cancelKey);
      return result !== null;
    } catch (error) {
      log.error('Error checking batch cancellation status', {
        batchId,
        error: error.message
      });
      return false;
    }
  }
}

module.exports = JobQueueManager;