/**
 * Metrics Manager for Distributed Worker Architecture
 * 
 * Collects and exposes Prometheus-compatible metrics for monitoring.
 * Tracks task processing, cache hit rates, queue depth, and performance metrics.
 * 
 * Requirements: 13.2, 13.3
 */

const { createStructuredLogger } = require('../logger/structured');
const { 
  JOB_QUEUE, 
  RESULT_CACHE, 
  PROGRESS_TRACKER,
  WORKER_HEARTBEAT 
} = require('../redis/keys');

class MetricsManager {
  constructor(redisClient) {
    this.redis = redisClient;
    this.logger = createStructuredLogger('metrics-manager');
    
    // Metrics storage
    this.metrics = {
      tasksProcessedTotal: 0,
      cacheHitRate: 0,
      avgCheckDurationSeconds: 0,
      queueDepth: 0,
      activeWorkers: 0,
      errorRate: 0,
      lastUpdated: Date.now()
    };
    
    // Performance tracking
    this.taskDurations = []; // Rolling window of task durations
    this.maxDurationSamples = 1000; // Keep last 1000 task durations
    
    // Error rate tracking (rolling window of 100 tasks)
    this.taskResults = []; // Array of {status, timestamp}
    this.maxResultSamples = 100; // Keep last 100 task results
    this.errorRateThreshold = 0.05; // 5% error rate threshold
    
    // Cache statistics
    this.cacheStats = {
      hits: 0,
      misses: 0,
      total: 0
    };
    
    this.logger.info('MetricsManager initialized');
  }

  /**
   * Update metrics from task completion
   * @param {Object} taskData - Task completion data
   */
  updateTaskMetrics(taskData) {
    try {
      const { status, duration, errorCode } = taskData;
      
      // Increment total tasks processed
      this.metrics.tasksProcessedTotal++;
      
      // Track task result for error rate calculation
      this.taskResults.push({
        status,
        timestamp: Date.now(),
        errorCode
      });
      
      // Keep only recent samples
      if (this.taskResults.length > this.maxResultSamples) {
        this.taskResults.shift();
      }
      
      // Update error rate
      this.metrics.errorRate = this._calculateErrorRate();
      
      // Check if error rate exceeds threshold
      if (this.metrics.errorRate > this.errorRateThreshold) {
        this._logErrorRateWarning();
      }
      
      // Track task duration (convert ms to seconds)
      if (duration && duration > 0) {
        const durationSeconds = duration / 1000;
        this.taskDurations.push(durationSeconds);
        
        // Keep only recent samples
        if (this.taskDurations.length > this.maxDurationSamples) {
          this.taskDurations.shift();
        }
        
        // Update average duration
        this.metrics.avgCheckDurationSeconds = this._calculateAverageDuration();
      }
      
      this.logger.debug('Task metrics updated', {
        tasksProcessedTotal: this.metrics.tasksProcessedTotal,
        avgDuration: this.metrics.avgCheckDurationSeconds,
        errorRate: this.metrics.errorRate,
        status
      });
      
    } catch (error) {
      this.logger.error('Failed to update task metrics', {
        error: error.message,
        taskData
      });
    }
  }

  /**
   * Update cache hit rate metrics
   * @param {boolean} isHit - Whether this was a cache hit
   */
  updateCacheMetrics(isHit) {
    try {
      this.cacheStats.total++;
      
      if (isHit) {
        this.cacheStats.hits++;
      } else {
        this.cacheStats.misses++;
      }
      
      // Calculate hit rate
      this.metrics.cacheHitRate = this.cacheStats.total > 0 
        ? this.cacheStats.hits / this.cacheStats.total 
        : 0;
      
      this.logger.debug('Cache metrics updated', {
        hits: this.cacheStats.hits,
        misses: this.cacheStats.misses,
        hitRate: this.metrics.cacheHitRate
      });
      
    } catch (error) {
      this.logger.error('Failed to update cache metrics', {
        error: error.message,
        isHit
      });
    }
  }

  /**
   * Update queue depth from Redis
   */
  async updateQueueDepth() {
    try {
      // Get main queue length
      const mainQueueLength = await this.redis.executeCommand('llen', JOB_QUEUE.tasks);
      
      // Get retry queue length
      const retryQueueLength = await this.redis.executeCommand('llen', JOB_QUEUE.retry);
      
      // Total queue depth
      this.metrics.queueDepth = (mainQueueLength || 0) + (retryQueueLength || 0);
      
      this.logger.debug('Queue depth updated', {
        mainQueue: mainQueueLength,
        retryQueue: retryQueueLength,
        total: this.metrics.queueDepth
      });
      
    } catch (error) {
      this.logger.error('Failed to update queue depth', {
        error: error.message
      });
    }
  }

  /**
   * Update active worker count from Redis heartbeats
   */
  async updateActiveWorkers() {
    try {
      // Scan for worker heartbeat keys
      const pattern = WORKER_HEARTBEAT.pattern;
      const keys = await this.redis.executeCommand('keys', pattern);
      
      this.metrics.activeWorkers = keys ? keys.length : 0;
      
      this.logger.debug('Active workers updated', {
        activeWorkers: this.metrics.activeWorkers
      });
      
    } catch (error) {
      this.logger.error('Failed to update active workers', {
        error: error.message
      });
    }
  }

  /**
   * Calculate average task duration from recent samples
   * @returns {number} Average duration in seconds
   */
  _calculateAverageDuration() {
    if (this.taskDurations.length === 0) {
      return 0;
    }
    
    const sum = this.taskDurations.reduce((acc, duration) => acc + duration, 0);
    return sum / this.taskDurations.length;
  }

  /**
   * Calculate error rate from recent task results
   * @returns {number} Error rate (0.0 to 1.0)
   */
  _calculateErrorRate() {
    if (this.taskResults.length === 0) {
      return 0;
    }
    
    const errorCount = this.taskResults.filter(result => result.status === 'ERROR').length;
    return errorCount / this.taskResults.length;
  }

  /**
   * Get error breakdown by error code
   * @returns {Object} Error breakdown {errorCode: count}
   */
  _getErrorBreakdown() {
    const breakdown = {};
    
    this.taskResults
      .filter(result => result.status === 'ERROR' && result.errorCode)
      .forEach(result => {
        const errorCode = result.errorCode;
        breakdown[errorCode] = (breakdown[errorCode] || 0) + 1;
      });
    
    return breakdown;
  }

  /**
   * Log error rate warning when threshold exceeded
   */
  _logErrorRateWarning() {
    // Throttle warnings to once per minute
    const now = Date.now();
    if (this.lastErrorRateWarning && (now - this.lastErrorRateWarning) < 60000) {
      return;
    }
    
    this.lastErrorRateWarning = now;
    
    const errorBreakdown = this._getErrorBreakdown();
    
    this.logger.logErrorRateWarning({
      errorRate: this.metrics.errorRate,
      threshold: this.errorRateThreshold,
      windowSize: this.taskResults.length,
      errorBreakdown
    });
  }

  /**
   * Get current metrics snapshot
   * @returns {Object} Current metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      lastUpdated: Date.now()
    };
  }

  /**
   * Generate Prometheus-formatted metrics
   * @returns {string} Prometheus metrics format
   */
  generatePrometheusMetrics() {
    const timestamp = Date.now();
    
    const lines = [];
    
    // Help and type declarations
    lines.push('# HELP tasks_processed_total Total number of credential check tasks processed');
    lines.push('# TYPE tasks_processed_total counter');
    lines.push(`tasks_processed_total ${this.metrics.tasksProcessedTotal} ${timestamp}`);
    lines.push('');
    
    lines.push('# HELP cache_hit_rate Cache hit rate for credential results (0.0 to 1.0)');
    lines.push('# TYPE cache_hit_rate gauge');
    lines.push(`cache_hit_rate ${this.metrics.cacheHitRate.toFixed(4)} ${timestamp}`);
    lines.push('');
    
    lines.push('# HELP avg_check_duration_seconds Average credential check duration in seconds');
    lines.push('# TYPE avg_check_duration_seconds gauge');
    lines.push(`avg_check_duration_seconds ${this.metrics.avgCheckDurationSeconds.toFixed(4)} ${timestamp}`);
    lines.push('');
    
    lines.push('# HELP queue_depth Current number of tasks in processing queue');
    lines.push('# TYPE queue_depth gauge');
    lines.push(`queue_depth ${this.metrics.queueDepth} ${timestamp}`);
    lines.push('');
    
    lines.push('# HELP active_workers Number of active worker nodes');
    lines.push('# TYPE active_workers gauge');
    lines.push(`active_workers ${this.metrics.activeWorkers} ${timestamp}`);
    lines.push('');
    
    lines.push('# HELP error_rate Error rate over recent tasks (0.0 to 1.0)');
    lines.push('# TYPE error_rate gauge');
    lines.push(`error_rate ${this.metrics.errorRate.toFixed(4)} ${timestamp}`);
    lines.push('');
    
    // Additional metrics
    lines.push('# HELP cache_hits_total Total cache hits');
    lines.push('# TYPE cache_hits_total counter');
    lines.push(`cache_hits_total ${this.cacheStats.hits} ${timestamp}`);
    lines.push('');
    
    lines.push('# HELP cache_misses_total Total cache misses');
    lines.push('# TYPE cache_misses_total counter');
    lines.push(`cache_misses_total ${this.cacheStats.misses} ${timestamp}`);
    lines.push('');
    
    // Task duration quantiles (if we have samples)
    if (this.taskDurations.length > 0) {
      const sorted = [...this.taskDurations].sort((a, b) => a - b);
      const p50 = this._getPercentile(sorted, 0.5);
      const p95 = this._getPercentile(sorted, 0.95);
      const p99 = this._getPercentile(sorted, 0.99);
      
      lines.push('# HELP check_duration_seconds_quantile Task duration quantiles');
      lines.push('# TYPE check_duration_seconds_quantile gauge');
      lines.push(`check_duration_seconds_quantile{quantile="0.5"} ${p50.toFixed(4)} ${timestamp}`);
      lines.push(`check_duration_seconds_quantile{quantile="0.95"} ${p95.toFixed(4)} ${timestamp}`);
      lines.push(`check_duration_seconds_quantile{quantile="0.99"} ${p99.toFixed(4)} ${timestamp}`);
      lines.push('');
    }
    
    return lines.join('\n');
  }

  /**
   * Calculate percentile from sorted array
   * @param {Array<number>} sorted - Sorted array of values
   * @param {number} percentile - Percentile (0.0 to 1.0)
   * @returns {number} Percentile value
   */
  _getPercentile(sorted, percentile) {
    if (sorted.length === 0) return 0;
    
    const index = Math.ceil(sorted.length * percentile) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
  }

  /**
   * Update all metrics from Redis
   */
  async updateAllMetrics() {
    try {
      await Promise.all([
        this.updateQueueDepth(),
        this.updateActiveWorkers()
      ]);
      
      this.metrics.lastUpdated = Date.now();
      
      // Log structured metrics
      this.logger.logMetrics(this.getMetrics());
      
    } catch (error) {
      this.logger.error('Failed to update all metrics', {
        error: error.message
      });
    }
  }

  /**
   * Start periodic metrics collection
   * @param {number} intervalMs - Update interval in milliseconds (default: 30s)
   */
  startPeriodicCollection(intervalMs = 30000) {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
    
    this.metricsInterval = setInterval(async () => {
      await this.updateAllMetrics();
    }, intervalMs);
    
    this.logger.info('Periodic metrics collection started', {
      intervalMs
    });
  }

  /**
   * Stop periodic metrics collection
   */
  stopPeriodicCollection() {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
      
      this.logger.info('Periodic metrics collection stopped');
    }
  }
}

module.exports = MetricsManager;