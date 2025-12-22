/**
 * Structured JSON Logger for Distributed Worker Architecture
 * 
 * Provides structured logging with JSON formatting for:
 * - Task completions with status, duration, proxy, worker ID
 * - Error tracking with error codes and context
 * - Performance metrics and monitoring data
 * - Distributed system correlation via trace IDs
 */

const util = require('util');
const { createLogger: createBaseLogger } = require('../../logger');

/**
 * Log levels with numeric weights for filtering
 */
const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4
};

/**
 * Get current log level from environment
 */
function getCurrentLogLevel() {
  const level = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LOG_LEVELS.hasOwnProperty(level) ? level : 'info';
}

/**
 * Check if a log level should be output
 */
function shouldLog(level) {
  const currentLevel = getCurrentLogLevel();
  return LOG_LEVELS[level] <= LOG_LEVELS[currentLevel];
}

/**
 * Format structured log entry as JSON
 */
function formatStructuredLog(level, scope, message, context = {}) {
  const timestamp = new Date().toISOString();
  
  const logEntry = {
    timestamp,
    level: level.toUpperCase(),
    scope,
    message,
    ...context
  };
  
  // Add process information
  logEntry.process = {
    pid: process.pid,
    hostname: process.env.HOSTNAME || require('os').hostname(),
    nodeVersion: process.version
  };
  
  // Add trace ID if available (for distributed tracing)
  if (context.traceId || process.env.TRACE_ID) {
    logEntry.traceId = context.traceId || process.env.TRACE_ID;
  }
  
  return JSON.stringify(logEntry);
}

/**
 * Enhanced logger with structured JSON output
 */
class StructuredLogger {
  constructor(scope = 'app', options = {}) {
    this.scope = scope;
    this.options = {
      enableConsoleOutput: options.enableConsoleOutput !== false,
      enableJsonOutput: options.enableJsonOutput !== false,
      ...options
    };
    
    // Create base logger for console output
    this.baseLogger = createBaseLogger(scope);
  }

  /**
   * Log with structured JSON format
   */
  log(level, message, context = {}) {
    if (!shouldLog(level)) {
      return;
    }

    // Console output (existing format)
    if (this.options.enableConsoleOutput) {
      this.baseLogger[level](message, context);
    }

    // JSON output to stdout (for log aggregation)
    if (this.options.enableJsonOutput) {
      const jsonLog = formatStructuredLog(level, this.scope, message, context);
      console.log(jsonLog);
    }
  }

  /**
   * Log task completion with structured data
   */
  logTaskCompletion(taskData) {
    const {
      taskId,
      batchId,
      username,
      status,
      duration,
      proxyId,
      workerId,
      errorCode,
      ipAddress
    } = taskData;

    this.log('info', 'Task completed', {
      event: 'task_completion',
      taskId,
      batchId,
      username: username ? username.replace(/(.{3}).*(@.*)/, '$1***$2') : undefined, // Mask email
      status,
      duration,
      proxyId,
      workerId,
      errorCode,
      ipAddress,
      timestamp: Date.now()
    });
  }

  /**
   * Log error with structured context
   */
  logError(message, error, context = {}) {
    const errorContext = {
      event: 'error',
      errorCode: error.code || 'UNKNOWN_ERROR',
      errorMessage: error.message,
      stack: error.stack,
      ...context
    };

    this.log('error', message, errorContext);
  }

  /**
   * Log worker heartbeat
   */
  logWorkerHeartbeat(workerData) {
    const {
      workerId,
      tasksCompleted,
      currentTask,
      uptime,
      memoryUsage
    } = workerData;

    this.log('debug', 'Worker heartbeat', {
      event: 'worker_heartbeat',
      workerId,
      tasksCompleted,
      currentTask,
      uptime,
      memoryUsage,
      timestamp: Date.now()
    });
  }

  /**
   * Log batch progress
   */
  logBatchProgress(progressData) {
    const {
      batchId,
      total,
      completed,
      percentage,
      estimatedTimeRemaining,
      throughput
    } = progressData;

    this.log('info', 'Batch progress update', {
      event: 'batch_progress',
      batchId,
      total,
      completed,
      percentage,
      estimatedTimeRemaining,
      throughput,
      timestamp: Date.now()
    });
  }

  /**
   * Log proxy health change
   */
  logProxyHealth(proxyData) {
    const {
      proxyId,
      proxyUrl,
      healthy,
      consecutiveFailures,
      successRate,
      lastSuccess,
      lastFailure
    } = proxyData;

    this.log('info', 'Proxy health update', {
      event: 'proxy_health',
      proxyId,
      proxyUrl: proxyUrl ? proxyUrl.replace(/:\/\/.*@/, '://***@') : undefined, // Mask credentials
      healthy,
      consecutiveFailures,
      successRate,
      lastSuccess,
      lastFailure,
      timestamp: Date.now()
    });
  }

  /**
   * Log coordinator failover
   */
  logCoordinatorFailover(failoverData) {
    const {
      previousCoordinator,
      newCoordinator,
      reason,
      inProgressBatches,
      pendingForwards
    } = failoverData;

    this.log('warn', 'Coordinator failover', {
      event: 'coordinator_failover',
      previousCoordinator,
      newCoordinator,
      reason,
      inProgressBatches,
      pendingForwards,
      timestamp: Date.now()
    });
  }

  /**
   * Log performance metrics
   */
  logMetrics(metricsData) {
    this.log('info', 'Performance metrics', {
      event: 'metrics',
      ...metricsData,
      timestamp: Date.now()
    });
  }

  /**
   * Log queue depth warning
   */
  logQueueDepthWarning(queueData) {
    const { depth, threshold, activeWorkers, estimatedDrainTime } = queueData;

    this.log('warn', 'Queue depth exceeds threshold', {
      event: 'queue_depth_warning',
      depth,
      threshold,
      activeWorkers,
      estimatedDrainTime,
      timestamp: Date.now()
    });
  }

  /**
   * Log error rate warning
   */
  logErrorRateWarning(errorData) {
    const { errorRate, threshold, windowSize, errorBreakdown } = errorData;

    this.log('warn', 'Error rate exceeds threshold', {
      event: 'error_rate_warning',
      errorRate,
      threshold,
      windowSize,
      errorBreakdown,
      timestamp: Date.now()
    });
  }

  /**
   * Create child logger with additional scope
   */
  child(childScope, options = {}) {
    const newScope = childScope ? `${this.scope}:${childScope}` : this.scope;
    return new StructuredLogger(newScope, { ...this.options, ...options });
  }

  // Standard log level methods
  error(message, context) { this.log('error', message, context); }
  warn(message, context) { this.log('warn', message, context); }
  info(message, context) { this.log('info', message, context); }
  debug(message, context) { this.log('debug', message, context); }
  trace(message, context) { this.log('trace', message, context); }
}

/**
 * Create structured logger instance
 */
function createStructuredLogger(scope = 'app', options = {}) {
  return new StructuredLogger(scope, options);
}

/**
 * Middleware for adding trace ID to logs
 */
function withTraceId(traceId, fn) {
  const originalTraceId = process.env.TRACE_ID;
  process.env.TRACE_ID = traceId;
  
  try {
    return fn();
  } finally {
    if (originalTraceId) {
      process.env.TRACE_ID = originalTraceId;
    } else {
      delete process.env.TRACE_ID;
    }
  }
}

/**
 * Generate correlation ID for distributed tracing
 */
function generateTraceId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${timestamp}-${random}`;
}

module.exports = {
  StructuredLogger,
  createStructuredLogger,
  withTraceId,
  generateTraceId,
  formatStructuredLog,
  LOG_LEVELS,
  getCurrentLogLevel,
  shouldLog
};