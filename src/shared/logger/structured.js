/**
 * Structured logger wrapper.
 *
 * Thin compatibility layer over the unified createLogger() that preserves the
 * task-specific helper API (logTaskCompletion, logError, etc.) used by
 * Coordinator, WorkerNode, ProxyPoolManager, ProgressTracker, MetricsServer
 * and MetricsManager.
 *
 * Output mode (human vs JSON) is controlled globally by LOG_FORMAT /
 * JSON_LOGGING env vars — see logger.js. There is no per-instance
 * console/json toggle; the options argument is accepted for backward
 * compatibility and intentionally ignored.
 */

const { createLogger } = require('./logger');

function createStructuredLogger(scope = 'app', _options = {}) {
  const base = createLogger(scope);

  function log(level, message, context = {}) {
    if (typeof base[level] === 'function') base[level](message, context);
  }

  return {
    log,
    error: (message, context) => log('error', message, context),
    warn: (message, context) => log('warn', message, context),
    info: (message, context) => log('info', message, context),
    debug: (message, context) => log('debug', message, context),
    trace: (message, context) => log('trace', message, context),
    success: (message, context) => log('success', message, context),

    logTaskCompletion(taskData) {
      const { taskId, batchId, username, status, duration, proxyId, workerId, errorCode, ipAddress } = taskData;
      log('info', 'Task completed', {
        event: 'task_completion',
        taskId,
        batchId,
        username: username ? username.replace(/(.{3}).*(@.*)/, '$1***$2') : undefined,
        status,
        duration,
        proxyId,
        workerId,
        errorCode,
        ipAddress,
        timestamp: Date.now(),
      });
    },

    logError(message, error, context = {}) {
      log('error', message, {
        event: 'error',
        errorCode: error.code || 'UNKNOWN_ERROR',
        errorMessage: error.message,
        stack: error.stack,
        ...context,
      });
    },

    logWorkerHeartbeat(workerData) {
      const { workerId, tasksCompleted, concurrency, activeTasks, taskIds, utilization, uptime, memoryUsage } = workerData;
      log('debug', 'Worker heartbeat', {
        event: 'worker_heartbeat',
        workerId,
        tasksCompleted,
        concurrency,
        activeTasks,
        taskIds,
        utilization,
        uptime,
        memoryUsage,
        timestamp: Date.now(),
      });
    },

    logWorkerMetrics(metricsData) {
      const { workerId, activeTasks, concurrency, utilization, tasksCompleted, tasksPerMinute, uptime, memory } = metricsData;
      log('info', 'Worker metrics', {
        event: 'worker_metrics',
        workerId,
        activeTasks,
        concurrency,
        utilization,
        tasksCompleted,
        tasksPerMinute,
        uptime,
        memory: memory ? {
          heapUsedMB: Math.round(memory.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(memory.heapTotal / 1024 / 1024),
          rssMB: Math.round(memory.rss / 1024 / 1024),
        } : undefined,
        timestamp: Date.now(),
      });
    },

    logBatchProgress(progressData) {
      const { batchId, total, completed, percentage, estimatedTimeRemaining, throughput } = progressData;
      log('info', 'Batch progress update', {
        event: 'batch_progress',
        batchId,
        total,
        completed,
        percentage,
        estimatedTimeRemaining,
        throughput,
        timestamp: Date.now(),
      });
    },

    logProxyHealth(proxyData) {
      const { proxyId, proxyUrl, healthy, consecutiveFailures, successRate, lastSuccess, lastFailure } = proxyData;
      log('info', 'Proxy health update', {
        event: 'proxy_health',
        proxyId,
        proxyUrl: proxyUrl ? proxyUrl.replace(/:\/\/.*@/, '://***@') : undefined,
        healthy,
        consecutiveFailures,
        successRate,
        lastSuccess,
        lastFailure,
        timestamp: Date.now(),
      });
    },

    logCoordinatorFailover(failoverData) {
      const { previousCoordinator, newCoordinator, reason, inProgressBatches, pendingForwards } = failoverData;
      log('warn', 'Coordinator failover', {
        event: 'coordinator_failover',
        previousCoordinator,
        newCoordinator,
        reason,
        inProgressBatches,
        pendingForwards,
        timestamp: Date.now(),
      });
    },

    logMetrics(metricsData) {
      log('info', 'Performance metrics', {
        event: 'metrics',
        ...metricsData,
        timestamp: Date.now(),
      });
    },

    logQueueDepthWarning(queueData) {
      const { depth, threshold, activeWorkers, estimatedDrainTime } = queueData;
      log('warn', 'Queue depth exceeds threshold', {
        event: 'queue_depth_warning',
        depth,
        threshold,
        activeWorkers,
        estimatedDrainTime,
        timestamp: Date.now(),
      });
    },

    logErrorRateWarning(errorData) {
      const { errorRate, threshold, windowSize, errorBreakdown } = errorData;
      log('warn', 'Error rate exceeds threshold', {
        event: 'error_rate_warning',
        errorRate,
        threshold,
        windowSize,
        errorBreakdown,
        timestamp: Date.now(),
      });
    },
  };
}

module.exports = {
  createStructuredLogger,
};
