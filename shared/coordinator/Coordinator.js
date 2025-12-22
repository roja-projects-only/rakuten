/**
 * Coordinator - Main orchestrator for distributed worker architecture
 * 
 * Integrates all coordinator components and maintains existing Telegram bot functionality
 * while adding distributed processing capabilities with high availability features.
 * 
 * Requirements: 9.1, 10.1, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 8.2, 8.3, 8.6
 */

const { Telegraf } = require('telegraf');
const { createLogger } = require('../../logger');
const { createStructuredLogger } = require('../logger/structured');
const { 
  JobQueueManager,
  ProxyPoolManager, 
  ProgressTracker,
  ChannelForwarder
} = require('./index');
const { 
  COORDINATOR_HEARTBEAT,
  COORDINATOR_LOCK,
  WORKER_HEARTBEAT,
  PROGRESS_TRACKER,
  JOB_QUEUE,
  PUBSUB_CHANNELS,
  generateBatchId
} = require('../redis/keys');

const log = createLogger('coordinator');

class Coordinator {
  constructor(redisClient, telegram, options = {}) {
    this.redis = redisClient;
    this.telegram = telegram;
    this.options = options;
    this.logger = createStructuredLogger('Coordinator');
    
    // Generate unique coordinator ID for HA
    this.coordinatorId = `coord-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    
    // Initialize component managers
    this.proxyPool = new ProxyPoolManager(redisClient, options.proxies);
    this.jobQueue = new JobQueueManager(redisClient, this.proxyPool);
    this.progressTracker = new ProgressTracker(redisClient, telegram);
    this.channelForwarder = new ChannelForwarder(redisClient, telegram, options.channelId);
    
    // Health monitoring
    this.activeWorkers = new Map(); // workerId -> lastHeartbeat timestamp
    this.isRunning = false;
    this.startTime = null;
    this.heartbeatInterval = null;
    this.healthMonitorInterval = null;
    this.zombieRecoveryInterval = null;
    
    // Bind methods to preserve 'this' context
    this.handleWorkerHeartbeat = this.handleWorkerHeartbeat.bind(this);
    this.sendHeartbeat = this.sendHeartbeat.bind(this);
    this.detectDeadWorkers = this.detectDeadWorkers.bind(this);
    this.recoverZombieTasks = this.recoverZombieTasks.bind(this);
    
    this.logger.info('Coordinator initialized', {
      coordinatorId: this.coordinatorId,
      channelId: options.channelId,
      proxyCount: options.proxies?.length || 0
    });
  }

  /**
   * Start the coordinator with all components and HA features
   */
  async start() {
    if (this.isRunning) {
      this.logger.warn('Coordinator already running');
      return;
    }

    try {
      this.logger.info('Starting coordinator...', { coordinatorId: this.coordinatorId });

      // Start progress tracker (subscribe to pub/sub events)
      await this.progressTracker.subscribeToProgressEvents();
      
      // Start channel forwarder (subscribe to forward/update events)
      await this.channelForwarder.start();
      
      // Subscribe to worker heartbeats for health monitoring
      await this.subscribeToWorkerHeartbeats();
      
      // Start coordinator heartbeat (every 30 seconds)
      this.heartbeatInterval = setInterval(this.sendHeartbeat, 30000);
      
      // Start health monitoring (every 30 seconds)
      this.healthMonitorInterval = setInterval(this.detectDeadWorkers, 30000);
      
      // Start zombie task recovery (every 60 seconds)
      this.zombieRecoveryInterval = setInterval(this.recoverZombieTasks, 60000);
      
      // Perform crash recovery
      await this.performCrashRecovery();
      
      this.isRunning = true;
      this.startTime = Date.now();
      this.logger.info('Coordinator started successfully', { coordinatorId: this.coordinatorId });
      
    } catch (error) {
      this.logger.error('Failed to start coordinator', {
        coordinatorId: this.coordinatorId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Stop the coordinator gracefully
   */
  async stop() {
    if (!this.isRunning) {
      this.logger.warn('Coordinator not running');
      return;
    }

    try {
      this.logger.info('Stopping coordinator...', { coordinatorId: this.coordinatorId });

      // Clear intervals
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      
      if (this.healthMonitorInterval) {
        clearInterval(this.healthMonitorInterval);
        this.healthMonitorInterval = null;
      }
      
      if (this.zombieRecoveryInterval) {
        clearInterval(this.zombieRecoveryInterval);
        this.zombieRecoveryInterval = null;
      }
      
      // Stop components
      await this.channelForwarder.stop();
      
      // Clean up coordinator heartbeat
      await this.redis.executeCommand('del', COORDINATOR_HEARTBEAT.key);
      
      this.isRunning = false;
      this.logger.info('Coordinator stopped', { coordinatorId: this.coordinatorId });
      
    } catch (error) {
      this.logger.error('Error stopping coordinator', {
        coordinatorId: this.coordinatorId,
        error: error.message
      });
    }
  }

  /**
   * Submit a batch for distributed processing
   * Routes batch submissions to JobQueueManager
   */
  async submitBatch(batchId, credentials, options = {}) {
    try {
      this.logger.info('Submitting batch for processing', {
        batchId,
        credentialCount: credentials.length,
        batchType: options.batchType
      });

      // Initialize progress tracker first
      await this.progressTracker.initBatch(
        batchId,
        credentials.length,
        options.chatId,
        options.messageId
      );

      // Enqueue batch through JobQueueManager
      const result = await this.jobQueue.enqueueBatch(batchId, credentials, options);
      
      this.logger.info('Batch submitted successfully', {
        batchId,
        queued: result.queued,
        cached: result.cached
      });

      return result;
      
    } catch (error) {
      this.logger.error('Failed to submit batch', {
        batchId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Cancel an active batch
   */
  async cancelBatch(batchId) {
    try {
      this.logger.info('Cancelling batch', { batchId });
      
      const result = await this.jobQueue.cancelBatch(batchId);
      
      this.logger.info('Batch cancelled', {
        batchId,
        drainedTasks: result.drained
      });
      
      return result;
      
    } catch (error) {
      this.logger.error('Failed to cancel batch', {
        batchId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get system status for /status command
   */
  async getSystemStatus() {
    try {
      // Get queue statistics
      const queueStats = await this.jobQueue.getQueueStats();
      
      // Get proxy statistics
      const proxyStats = await this.proxyPool.getProxyStats();
      
      // Get active worker count
      const activeWorkerCount = this.activeWorkers.size;
      const workerStats = Array.from(this.activeWorkers.entries()).map(([workerId, lastHeartbeat]) => ({
        workerId,
        lastHeartbeat,
        age: Date.now() - lastHeartbeat,
        healthy: (Date.now() - lastHeartbeat) < 30000
      }));
      
      return {
        coordinator: {
          id: this.coordinatorId,
          uptime: this.isRunning ? Date.now() - (this.startTime || Date.now()) : 0,
          running: this.isRunning
        },
        queue: queueStats,
        workers: {
          active: activeWorkerCount,
          details: workerStats
        },
        proxies: {
          total: proxyStats.length,
          healthy: proxyStats.filter(p => p.healthy).length,
          details: proxyStats
        }
      };
      
    } catch (error) {
      this.logger.error('Failed to get system status', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Format system status for Telegram display
   */
  formatSystemStatus(status) {
    const { escapeV2, codeV2, boldV2 } = require('../../telegram/messages/helpers');
    
    const uptimeMs = status.coordinator.uptime;
    const uptimeMinutes = Math.floor(uptimeMs / 60000);
    const uptimeHours = Math.floor(uptimeMinutes / 60);
    const remainingMinutes = uptimeMinutes % 60;
    
    const uptimeStr = uptimeHours > 0 
      ? `${uptimeHours}h ${remainingMinutes}m`
      : `${uptimeMinutes}m`;
    
    const parts = [];
    
    // Header
    parts.push(`📊 ${boldV2('SYSTEM STATUS')}`);
    parts.push('');
    
    // Coordinator info
    parts.push(boldV2('🎛️ Coordinator'));
    parts.push(`├ ID: ${codeV2(status.coordinator.id.substring(0, 12) + '...')}`);
    parts.push(`├ Status: ${status.coordinator.running ? '🟢 Running' : '🔴 Stopped'}`);
    parts.push(`└ Uptime: ${codeV2(uptimeStr)}`);
    parts.push('');
    
    // Queue info
    parts.push(boldV2('📋 Job Queue'));
    parts.push(`├ Main Queue: ${codeV2(String(status.queue.mainQueue))}`);
    parts.push(`├ Retry Queue: ${codeV2(String(status.queue.retryQueue))}`);
    parts.push(`└ Total: ${codeV2(String(status.queue.total))}`);
    
    // Queue depth warning
    if (status.queue.total > 1000) {
      parts.push(`⚠️ ${escapeV2('High queue depth - consider adding workers')}`);
    }
    parts.push('');
    
    // Workers info
    parts.push(boldV2('👷 Workers'));
    parts.push(`├ Active: ${codeV2(String(status.workers.active))}`);
    
    if (status.workers.active === 0) {
      parts.push(`└ ⚠️ ${escapeV2('No active workers detected')}`);
    } else {
      const healthyWorkers = status.workers.details.filter(w => w.healthy).length;
      parts.push(`└ Healthy: ${codeV2(String(healthyWorkers))}/${codeV2(String(status.workers.active))}`);
      
      // Show recent worker activity
      const recentWorkers = status.workers.details
        .filter(w => w.age < 60000) // Last minute
        .slice(0, 3); // Show max 3
      
      if (recentWorkers.length > 0) {
        parts.push('');
        parts.push(boldV2('🔄 Recent Activity'));
        recentWorkers.forEach((worker, i) => {
          const prefix = i === recentWorkers.length - 1 ? '└' : '├';
          const ageSeconds = Math.round(worker.age / 1000);
          const workerId = worker.workerId.length > 15 
            ? worker.workerId.substring(0, 12) + '...'
            : worker.workerId;
          parts.push(`${prefix} ${codeV2(workerId)} (${ageSeconds}s ago)`);
        });
      }
    }
    parts.push('');
    
    // Proxies info
    if (status.proxies.total > 0) {
      parts.push(boldV2('🌐 Proxies'));
      parts.push(`├ Total: ${codeV2(String(status.proxies.total))}`);
      parts.push(`└ Healthy: ${codeV2(String(status.proxies.healthy))}/${codeV2(String(status.proxies.total))}`);
      
      // Show proxy health summary
      const unhealthyProxies = status.proxies.details.filter(p => !p.healthy);
      if (unhealthyProxies.length > 0) {
        parts.push(`⚠️ ${escapeV2(`${unhealthyProxies.length} proxy(ies) unhealthy`)}`);
      }
    } else {
      parts.push(boldV2('🌐 Proxies'));
      parts.push(`└ ${escapeV2('No proxies configured (direct connections)')}`);
    }
    
    return parts.join('\n');
  }

  /**
   * Send coordinator heartbeat every 30 seconds
   * Requirements: 12.1, 12.2
   */
  async sendHeartbeat() {
    try {
      const heartbeatData = {
        coordinatorId: this.coordinatorId,
        timestamp: Date.now(),
        activeWorkers: this.activeWorkers.size,
        uptime: Date.now() - (this.startTime || Date.now())
      };

      // SET coordinator:heartbeat with 30-second TTL
      await this.redis.executeCommand(
        'setex',
        COORDINATOR_HEARTBEAT.key,
        COORDINATOR_HEARTBEAT.ttl,
        JSON.stringify(heartbeatData)
      );

      this.logger.debug('Coordinator heartbeat sent', {
        coordinatorId: this.coordinatorId,
        activeWorkers: this.activeWorkers.size
      });

    } catch (error) {
      this.logger.error('Failed to send coordinator heartbeat', {
        coordinatorId: this.coordinatorId,
        error: error.message
      });
    }
  }

  /**
   * Subscribe to worker heartbeats for health monitoring
   * Requirements: 8.1, 8.2
   */
  async subscribeToWorkerHeartbeats() {
    try {
      // Subscribe to worker heartbeats channel
      await this.redis.executeCommand('subscribe', PUBSUB_CHANNELS.workerHeartbeats);
      
      // Set up message handler
      const client = this.redis.getClient();
      client.on('message', this.handleWorkerHeartbeat);
      
      this.logger.info('Subscribed to worker heartbeats');
      
    } catch (error) {
      this.logger.error('Failed to subscribe to worker heartbeats', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Handle worker heartbeat messages
   */
  async handleWorkerHeartbeat(channel, message) {
    if (channel !== PUBSUB_CHANNELS.workerHeartbeats) {
      return;
    }

    try {
      const { workerId, timestamp, tasksCompleted, batchId } = JSON.parse(message);
      
      // Update worker last seen time
      this.activeWorkers.set(workerId, timestamp);
      
      this.logger.debug('Worker heartbeat received', {
        workerId,
        timestamp,
        tasksCompleted,
        batchId
      });
      
      // Trigger progress update if batchId is provided
      if (batchId && await this.progressTracker.batchExists(batchId)) {
        await this.progressTracker.handleProgressUpdate(batchId);
      }
      
    } catch (error) {
      this.logger.warn('Failed to parse worker heartbeat message', {
        channel,
        message: message.substring(0, 100),
        error: error.message
      });
    }
  }

  /**
   * Detect dead workers (missing heartbeats for 30+ seconds)
   * Requirements: 8.2, 8.3
   */
  async detectDeadWorkers() {
    try {
      const now = Date.now();
      const deadThreshold = 30000; // 30 seconds
      const deadWorkers = [];
      
      for (const [workerId, lastHeartbeat] of this.activeWorkers) {
        const age = now - lastHeartbeat;
        
        if (age > deadThreshold) {
          deadWorkers.push({ workerId, lastHeartbeat, age });
          
          // Remove from active workers
          this.activeWorkers.delete(workerId);
          
          // Clean up Redis heartbeat key
          await this.redis.executeCommand('del', WORKER_HEARTBEAT.generate(workerId));
          
          this.logger.warn('Dead worker detected', {
            workerId,
            lastHeartbeat: new Date(lastHeartbeat).toISOString(),
            age: Math.round(age / 1000) + 's'
          });
        }
      }
      
      // Log queue depth warnings
      const queueStats = await this.jobQueue.getQueueStats();
      if (queueStats.total > 1000) {
        this.logger.warn('High queue depth detected - consider adding more workers', {
          queueDepth: queueStats.total,
          activeWorkers: this.activeWorkers.size,
          mainQueue: queueStats.mainQueue,
          retryQueue: queueStats.retryQueue
        });
      }
      
      if (deadWorkers.length > 0) {
        this.logger.info('Dead worker cleanup completed', {
          deadWorkerCount: deadWorkers.length,
          remainingWorkers: this.activeWorkers.size
        });
      }
      
    } catch (error) {
      this.logger.error('Failed to detect dead workers', {
        error: error.message
      });
    }
  }

  /**
   * Recover zombie tasks with expired leases
   * Scans Redis for expired task leases and re-enqueues them
   * Requirements: 1.7
   */
  async recoverZombieTasks() {
    try {
      this.logger.debug('Starting zombie task recovery scan');
      
      // Scan Redis for all task lease keys matching pattern: job:*
      const { KEY_PATTERNS, TASK_LEASE } = require('../redis/keys');
      const leaseKeys = await this.redis.executeCommand('keys', KEY_PATTERNS.allTaskLeases);
      
      if (leaseKeys.length === 0) {
        this.logger.debug('No task leases found');
        return;
      }
      
      this.logger.debug(`Found ${leaseKeys.length} task leases to check`);
      
      let recoveredCount = 0;
      let activeCount = 0;
      
      // Check each lease for expiration
      for (const leaseKey of leaseKeys) {
        try {
          // Check TTL: -2 means key doesn't exist (expired), -1 means no TTL, >0 means active
          const ttl = await this.redis.executeCommand('ttl', leaseKey);
          
          if (ttl === -2) {
            // Lease has expired - this is a zombie task
            // Extract batchId and taskId from key pattern: job:{batchId}:{taskId}
            const keyParts = leaseKey.split(':');
            if (keyParts.length !== 3) {
              this.logger.warn('Invalid lease key format, skipping', { leaseKey });
              continue;
            }
            
            const batchId = keyParts[1];
            const taskId = keyParts[2];
            
            // Get the task data from the lease (if it still exists)
            // Note: For expired leases, we need to get the data before it's cleaned up
            let taskData = await this.redis.executeCommand('get', leaseKey);
            
            if (!taskData) {
              // Lease key was already cleaned up, skip
              this.logger.debug('Lease key already cleaned up', { leaseKey, batchId, taskId });
              continue;
            }
            
            try {
              const task = JSON.parse(taskData);
              
              // Check if batch is cancelled before re-enqueuing
              const isCancelled = await this.jobQueue.isBatchCancelled(batchId);
              if (isCancelled) {
                this.logger.info('Skipping zombie task from cancelled batch', {
                  taskId,
                  batchId
                });
                // Clean up the expired lease
                await this.redis.executeCommand('del', leaseKey);
                continue;
              }
              
              // Re-enqueue the task through JobQueueManager retry logic
              // This will handle retry count and max retries enforcement
              const requeued = await this.jobQueue.retryTask(task, 'LEASE_EXPIRED');
              
              if (requeued) {
                recoveredCount++;
                this.logger.info('Recovered zombie task', {
                  taskId,
                  batchId,
                  retryCount: task.retryCount,
                  proxyId: task.proxyId
                });
              } else {
                this.logger.warn('Zombie task exceeded max retries, marked as ERROR', {
                  taskId,
                  batchId,
                  retryCount: task.retryCount
                });
              }
              
              // Clean up the expired lease
              await this.redis.executeCommand('del', leaseKey);
              
            } catch (parseError) {
              this.logger.warn('Failed to parse zombie task data', {
                leaseKey,
                error: parseError.message
              });
              // Clean up invalid lease
              await this.redis.executeCommand('del', leaseKey);
            }
            
          } else if (ttl > 0) {
            // Lease is still active
            activeCount++;
          }
          // ttl === -1 means no expiration set (shouldn't happen, but skip)
          
        } catch (error) {
          this.logger.warn('Error checking lease TTL', {
            leaseKey,
            error: error.message
          });
        }
      }
      
      if (recoveredCount > 0) {
        this.logger.info('Zombie task recovery completed', {
          totalLeases: leaseKeys.length,
          activeLeases: activeCount,
          recoveredTasks: recoveredCount
        });
      } else {
        this.logger.debug('Zombie task recovery completed - no zombies found', {
          totalLeases: leaseKeys.length,
          activeLeases: activeCount
        });
      }
      
    } catch (error) {
      this.logger.error('Failed to recover zombie tasks', {
        error: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Perform crash recovery on coordinator startup
   * Requirements: 12.1, 12.2, 12.5, 12.6
   */
  async performCrashRecovery() {
    try {
      this.logger.info('Performing crash recovery...');

      // Check for existing coordinator heartbeat
      const existingHeartbeat = await this.redis.executeCommand('get', COORDINATOR_HEARTBEAT.key);
      
      if (existingHeartbeat) {
        const heartbeatData = JSON.parse(existingHeartbeat);
        const age = Date.now() - heartbeatData.timestamp;
        
        this.logger.info('Found existing coordinator heartbeat', {
          existingCoordinatorId: heartbeatData.coordinatorId,
          timestamp: new Date(heartbeatData.timestamp).toISOString(),
          age: Math.round(age / 1000) + 's'
        });
        
        // If heartbeat is recent (< 60s), another coordinator may be active
        if (age < 60000) {
          this.logger.warn('Recent coordinator heartbeat detected - another coordinator may be active', {
            existingCoordinatorId: heartbeatData.coordinatorId,
            age: Math.round(age / 1000) + 's'
          });
          
          // Wait a bit to see if the other coordinator is still active
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          // Check again
          const recentHeartbeat = await this.redis.executeCommand('get', COORDINATOR_HEARTBEAT.key);
          if (recentHeartbeat) {
            const recentData = JSON.parse(recentHeartbeat);
            const recentAge = Date.now() - recentData.timestamp;
            
            if (recentAge < 30000) {
              this.logger.error('Active coordinator detected - cannot start backup coordinator', {
                activeCoordinatorId: recentData.coordinatorId,
                age: Math.round(recentAge / 1000) + 's'
              });
              throw new Error('Another coordinator is already active');
            }
          }
        }
      }

      // Acquire takeover lock to prevent multiple coordinators from taking over simultaneously
      const takeoverLock = await this.acquireLock('takeover', 60); // 60 second lock
      
      if (!takeoverLock.acquired) {
        this.logger.error('Failed to acquire takeover lock - another coordinator is taking over');
        throw new Error('Another coordinator is performing takeover');
      }

      try {
        // Scan for in-progress batches
        const progressKeys = await this.redis.executeCommand('keys', PROGRESS_TRACKER.pattern.replace('{batchId}', '*'));
        
        if (progressKeys.length > 0) {
          this.logger.info(`Found ${progressKeys.length} in-progress batches to resume`);
          
          for (const progressKey of progressKeys) {
            const batchId = progressKey.split(':')[1];
            const progressData = await this.redis.executeCommand('get', progressKey);
            
            if (!progressData) continue;
            
            try {
              const { total, chatId, messageId } = JSON.parse(progressData);
              
              // Get current completed count
              const counterKey = PROGRESS_TRACKER.generateCounter(batchId);
              const completedStr = await this.redis.executeCommand('get', counterKey);
              const completed = parseInt(completedStr) || 0;
              
              if (completed >= total) {
                // Batch is complete but summary may not have been sent
                this.logger.info(`Batch ${batchId} is complete, sending summary`);
                await this.progressTracker.sendSummary(batchId);
              } else {
                // Resume progress tracking
                this.logger.info(`Resuming progress tracking for batch ${batchId} (${completed}/${total})`);
                // Progress tracker will handle updates when workers send heartbeats
              }
              
            } catch (parseError) {
              this.logger.warn(`Failed to parse progress data for batch ${batchId}`, {
                error: parseError.message
              });
            }
          }
        }

        // Retry pending channel forwards
        await this.channelForwarder.retryPendingForwards();
        
        this.logger.info('Crash recovery completed');
        
      } finally {
        // Release takeover lock
        if (takeoverLock.lockValue) {
          await this.releaseLock(takeoverLock.lockKey, takeoverLock.lockValue);
        }
      }
      
    } catch (error) {
      this.logger.error('Failed to perform crash recovery', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Acquire distributed lock for multi-coordinator operations
   * Requirements: 12.3, 12.4
   */
  async acquireLock(operation, ttlSeconds = 10) {
    try {
      const lockKey = COORDINATOR_LOCK.generate(operation);
      const lockValue = `${this.coordinatorId}:${Date.now()}`;
      
      // Use SETNX with TTL for distributed locking
      const acquired = await this.redis.executeCommand('set', lockKey, lockValue, 'NX', 'EX', ttlSeconds);
      
      if (acquired === 'OK') {
        this.logger.debug('Distributed lock acquired', {
          operation,
          lockKey,
          coordinatorId: this.coordinatorId,
          ttl: ttlSeconds
        });
        return { acquired: true, lockKey, lockValue };
      } else {
        this.logger.debug('Failed to acquire distributed lock', {
          operation,
          lockKey,
          coordinatorId: this.coordinatorId
        });
        return { acquired: false, lockKey, lockValue: null };
      }
      
    } catch (error) {
      this.logger.error('Error acquiring distributed lock', {
        operation,
        coordinatorId: this.coordinatorId,
        error: error.message
      });
      return { acquired: false, lockKey: null, lockValue: null };
    }
  }

  /**
   * Release distributed lock
   */
  async releaseLock(lockKey, lockValue) {
    try {
      // Use Lua script to ensure we only delete our own lock
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      
      const result = await this.redis.executeCommand('eval', luaScript, 1, lockKey, lockValue);
      
      if (result === 1) {
        this.logger.debug('Distributed lock released', {
          lockKey,
          coordinatorId: this.coordinatorId
        });
        return true;
      } else {
        this.logger.warn('Failed to release distributed lock (not owner or expired)', {
          lockKey,
          coordinatorId: this.coordinatorId
        });
        return false;
      }
      
    } catch (error) {
      this.logger.error('Error releasing distributed lock', {
        lockKey,
        coordinatorId: this.coordinatorId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Execute operation with distributed lock
   */
  async withLock(operation, fn, ttlSeconds = 10) {
    const lock = await this.acquireLock(operation, ttlSeconds);
    
    if (!lock.acquired) {
      throw new Error(`Failed to acquire lock for operation: ${operation}`);
    }
    
    try {
      return await fn();
    } finally {
      if (lock.lockValue) {
        await this.releaseLock(lock.lockKey, lock.lockValue);
      }
    }
  }

  /**
   * Send Telegram message with distributed lock to prevent duplicates
   * Requirements: 12.3, 12.4
   */
  async sendTelegramMessageWithLock(chatId, text, options = {}) {
    const operation = `telegram_message_${chatId}`;
    
    return await this.withLock(operation, async () => {
      return await this.telegram.sendMessage(chatId, text, options);
    }, 10);
  }

  /**
   * Edit Telegram message with distributed lock to prevent conflicts
   * Requirements: 12.3, 12.4
   */
  async editTelegramMessageWithLock(chatId, messageId, text, options = {}) {
    const operation = `telegram_edit_${chatId}_${messageId}`;
    
    return await this.withLock(operation, async () => {
      return await this.telegram.editMessageText(chatId, messageId, null, text, options);
    }, 10);
  }
}

module.exports = Coordinator;