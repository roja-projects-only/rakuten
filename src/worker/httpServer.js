/**
 * Worker HTTP Status Server — lightweight health / status / metrics endpoints.
 *
 * Provides a simple HTTP interface so orchestrators and load balancers can
 * check worker health without using Redis.
 */

const http = require('http');

// ─── CORS ─────────────────────────────────────────────────────────────────────

function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// ─── Payload builders (pure functions of worker state) ────────────────────────

/**
 * @param {Object} state
 * @param {string} state.workerId
 * @param {number} state.activeTaskCount
 * @param {number} state.concurrency
 * @param {number} state.tasksCompleted
 * @param {number} state.startTime - timestamp (ms)
 * @returns {Object} health payload
 */
function buildHealthPayload(state) {
  const {
    workerId,
    activeTaskCount,
    concurrency,
    tasksCompleted,
    startTime,
  } = state;
  const now = Date.now();
  const uptimeMs = now - startTime;
  const tasksPerMinute = uptimeMs > 0 ? tasksCompleted / (uptimeMs / 60000) : 0;

  return {
    status: 'healthy',
    workerId,
    timestamp: new Date(now).toISOString(),
    uptimeMs,
    activeTasks: activeTaskCount,
    concurrency,
    tasksCompleted,
    tasksPerMinute: Number(tasksPerMinute.toFixed(2)),
    memory: {
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
  };
}

/**
 * @param {Object} state — same fields as buildHealthPayload plus powServiceUrl
 * @param {string} [state.powServiceUrl]
 * @returns {Object} full status payload
 */
function buildStatusPayload(state) {
  const health = buildHealthPayload(state);
  return {
    ...health,
    queue: {
      activeTasks: state.activeTaskCount,
      utilization: Math.round((state.activeTaskCount / state.concurrency) * 100),
    },
    powServiceUrl: state.powServiceUrl || null,
    startedAt: new Date(state.startTime).toISOString(),
  };
}

/**
 * Build a Prometheus-format metrics string.
 * @param {Object} state
 * @returns {string} text/plain metrics
 */
function buildMetricsPayload(state) {
  const {
    workerId,
    activeTaskCount,
    concurrency,
    tasksCompleted,
    startTime,
  } = state;
  const now = Date.now();
  const uptimeSeconds = (now - startTime) / 1000;
  const utilization = concurrency > 0 ? activeTaskCount / concurrency : 0;

  return [
    '# HELP worker_active_tasks Number of active tasks currently processing',
    '# TYPE worker_active_tasks gauge',
    `worker_active_tasks{workerId="${workerId}"} ${activeTaskCount}`,
    '# HELP worker_concurrency Configured concurrency per worker',
    '# TYPE worker_concurrency gauge',
    `worker_concurrency{workerId="${workerId}"} ${concurrency}`,
    '# HELP worker_tasks_completed_total Total tasks completed by this worker',
    '# TYPE worker_tasks_completed_total counter',
    `worker_tasks_completed_total{workerId="${workerId}"} ${tasksCompleted}`,
    '# HELP worker_utilization_ratio Current utilization (0-1)',
    '# TYPE worker_utilization_ratio gauge',
    `worker_utilization_ratio{workerId="${workerId}"} ${utilization.toFixed(4)}`,
    '# HELP worker_uptime_seconds Worker uptime in seconds',
    '# TYPE worker_uptime_seconds gauge',
    `worker_uptime_seconds{workerId="${workerId}"} ${uptimeSeconds.toFixed(0)}`,
  ].join('\n');
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

/**
 * Create and start the worker HTTP status server.
 *
 * @param {Object} opts
 * @param {number}   opts.httpPort   Port to bind
 * @param {string}   opts.workerId
 * @param {Function} opts.getState   () => state object with { activeTaskCount,
 *                                    concurrency, tasksCompleted, startTime,
 *                                    powServiceUrl }
 * @param {Object}   opts.log        Logger with .info / .warn / .debug
 * @returns {Promise<http.Server>}   Started server instance
 */
async function createWorkerHttpServer(opts) {
  const { httpPort, getState, log, workerId } = opts;

  const handler = async (req, res) => {
    try {
      const state = getState();

      if (req.method === 'OPTIONS') {
        res.writeHead(200, getCorsHeaders());
        return res.end();
      }

      if (req.method === 'GET' && req.url === '/health') {
        const payload = buildHealthPayload(state);
        res.writeHead(
          payload.status === 'healthy' ? 200 : 503,
          { 'Content-Type': 'application/json', ...getCorsHeaders() },
        );
        return res.end(JSON.stringify(payload));
      }

      if (req.method === 'GET' && req.url === '/status') {
        const payload = buildStatusPayload(state);
        res.writeHead(200, { 'Content-Type': 'application/json', ...getCorsHeaders() });
        return res.end(JSON.stringify(payload));
      }

      if (req.method === 'GET' && req.url === '/metrics') {
        const body = buildMetricsPayload(state);
        res.writeHead(200, {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          ...getCorsHeaders(),
        });
        return res.end(body);
      }

      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain', ...getCorsHeaders() });
        return res.end('worker status: /health /status /metrics\n');
      }

      res.writeHead(404, { 'Content-Type': 'text/plain', ...getCorsHeaders() });
      res.end('Not Found');
    } catch (error) {
      log.warn('Worker HTTP handler error', { error: error.message });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain', ...getCorsHeaders() });
      }
      res.end('Internal Error');
    }
  };

  const server = http.createServer(handler);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(httpPort, () => {
      log.info('Worker HTTP status server listening', { port: httpPort, workerId });
      resolve();
    });
  });

  return server;
}

module.exports = {
  createWorkerHttpServer,
  getCorsHeaders,
  buildHealthPayload,
  buildStatusPayload,
  buildMetricsPayload,
};
