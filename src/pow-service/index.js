/**
 * POW Service Entrypoint
 *
 * Starts the standalone Proof-of-Work HTTP microservice.
 * Always runs as pow-service.
 *
 * Optional env:
 *   PORT (default 3001), REDIS_URL (for caching), POW_NUM_WORKERS, POW_TASK_TIMEOUT
 */

require('dotenv').config();
const { createLogger } = require('../shared/logger');
const { getRedisClient } = require('../shared/redis/client');
const { validateEnvironment } = require('../shared/config/environment');

const log = createLogger('pow-service');

class POWService {
  constructor(options = {}) {
    this.port = options.port || process.env.PORT || 3001;
    this.redisClient = null;
    this.workerPool = null;
    this.app = null;
    this.server = null;
    this.hashImplementation = 'unknown';

    this.stats = {
      requestsTotal: 0,
      requestsSuccess: 0,
      requestsError: 0,
      cacheHits: 0,
      cacheMisses: 0,
      computeTimeTotal: 0,
      startTime: Date.now(),
    };
  }

  async initialize() {
    log.info('Initializing POW service...');

    // Validate environment for pow-service mode
    validateEnvironment('pow-service');

    // Initialize Redis (optional — for caching)
    if (process.env.REDIS_URL) {
      try {
        this.redisClient = getRedisClient();
        await this.redisClient.connect();
        log.info('Redis connected');
      } catch (error) {
        log.warn(`Redis connection failed — running without cache: ${error.message}`);
        this.redisClient = null;
      }
    } else {
      log.info('REDIS_URL not configured — running without cache');
    }

    // Initialize worker pool
    try {
      const { PowWorkerPool } = require('../shared/fingerprinting/powWorkerPool');
      const numWorkers = parseInt(process.env.POW_NUM_WORKERS, 10) || undefined;
      const taskTimeout = parseInt(process.env.POW_TASK_TIMEOUT, 10) || 30000;

      this.workerPool = new PowWorkerPool({
        numWorkers,
        taskTimeout,
        maxIterations: 8000000,
      });

      this.workerPool.init();
      log.info('Worker pool initialized');

      // Detect hash implementation for health endpoint
      try {
        require('murmurhash-native');
        this.hashImplementation = 'native';
        log.info('Hash implementation: native (murmurhash-native)');
      } catch {
        this.hashImplementation = 'js-fallback';
        log.warn('Hash implementation: JS fallback (murmurhash3js-revisited) — ~10x slower');
      }
    } catch (error) {
      log.error(`Worker pool init failed: ${error.message}`);
      throw error;
    }

    // Set up Express
    this.setupExpress();

    log.info('POW service initialization complete');
  }

  setupExpress() {
    const express = require('express');
    const cors = require('cors');
    const helmet = require('helmet');
    const compression = require('compression');

    this.app = express();
    this.app.use(helmet());
    this.app.use(cors());
    this.app.use(compression());
    this.app.use(express.json({ limit: '1mb' }));

    // Request logging
    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        log.info('HTTP request', {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration: Date.now() - start,
        });
      });
      next();
    });

    // Routes
    this.app.post('/compute', async (req, res) => {
      try {
        await this.handleCompute(req, res);
      } catch (error) {
        log.error('Compute error', { error: error.message });
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    });

    this.app.get('/health', async (req, res) => {
      try {
        await this.handleHealth(req, res);
      } catch (error) {
        res.status(500).json({ status: 'unhealthy', error: error.message });
      }
    });

    this.app.get('/metrics', async (req, res) => {
      try {
        await this.handleMetrics(req, res);
      } catch (error) {
        res.status(500).send('# Error generating metrics\n');
      }
    });

    this.app.get('/', (req, res) => {
      res.json({
        service: 'POW Service',
        version: '1.0.0',
        status: 'running',
        endpoints: {
          compute: 'POST /compute',
          health: 'GET /health',
          metrics: 'GET /metrics',
        },
      });
    });

    // 404
    this.app.use((req, res) => {
      res.status(404).json({ error: 'NOT_FOUND' });
    });
  }

  async handleCompute(req, res) {
    const startTime = Date.now();
    this.stats.requestsTotal++;

    const { mask, key, seed } = req.body;

    if (!mask || !key || seed === undefined) {
      this.stats.requestsError++;
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'Missing required fields: mask, key, seed',
      });
    }

    if (typeof mask !== 'string' || typeof key !== 'string' || typeof seed !== 'number') {
      this.stats.requestsError++;
      return res.status(400).json({ error: 'INVALID_TYPES' });
    }

    if (mask.length > 32 || key.length > 32) {
      this.stats.requestsError++;
      return res.status(400).json({ error: 'INVALID_LENGTH' });
    }

    try {
      // Check cache
      const cacheKey = `pow:${mask}:${key}:${seed}`;
      let cached = false;
      let cres = null;

      if (this.redisClient) {
        try {
          cres = await this.redisClient.executeCommand('get', cacheKey);
          if (cres) {
            cached = true;
            this.stats.cacheHits++;
          } else {
            this.stats.cacheMisses++;
          }
        } catch (err) {
          this.stats.cacheMisses++;
        }
      } else {
        this.stats.cacheMisses++;
      }

      // Compute if not cached
      if (!cres) {
        if (!this.workerPool) throw new Error('Worker pool not initialized');
        const result = await this.workerPool.solve({ mask, key, seed });
        cres = result.stringToHash;

        // Cache result
        if (this.redisClient) {
          try {
            await this.redisClient.executeCommand('setex', cacheKey, 300, cres);
          } catch (err) {
            // Non-fatal
          }
        }
      }

      const computeTimeMs = Date.now() - startTime;
      this.stats.requestsSuccess++;
      this.stats.computeTimeTotal += computeTimeMs;

      res.json({ cres, cached, computeTimeMs });

    } catch (error) {
      this.stats.requestsError++;

      if (error.message.includes('timeout') || error.message.includes('POW task')) {
        return res.status(408).json({ error: 'POW_TIMEOUT' });
      }
      if (error.code === 'POW_QUEUE_FULL') {
        return res.status(503).json({ error: 'POW_OVERLOADED' });
      }
      if (error.code === 'POW_FAILED' || error.code === 'POW_MAX_ITERATIONS') {
        return res.status(422).json({ error: 'POW_FAILED' });
      }

      res.status(500).json({ error: 'COMPUTATION_ERROR' });
    }
  }

  async handleHealth(req, res) {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: Date.now() - this.stats.startTime,
      hashImplementation: this.hashImplementation,
    };

    if (this.redisClient) {
      try {
        const isHealthy = await this.redisClient.isHealthy();
        health.redis = { status: isHealthy ? 'connected' : 'disconnected' };
      } catch (error) {
        health.redis = { status: 'error' };
        health.status = 'degraded';
      }
    }

    if (this.workerPool) {
      const poolStats = this.workerPool.getStats();
      health.workerPool = {
        status: poolStats.workers.alive > 0 ? 'healthy' : 'unhealthy',
        workers: poolStats.workers,
      };
    }

    const statusCode = health.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(health);
  }

  async handleMetrics(req, res) {
    const metrics = [];
    metrics.push('# HELP pow_requests_total Total POW requests');
    metrics.push(`pow_requests_total{status="success"} ${this.stats.requestsSuccess}`);
    metrics.push(`pow_requests_total{status="error"} ${this.stats.requestsError}`);

    const totalCache = this.stats.cacheHits + this.stats.cacheMisses;
    const hitRate = totalCache > 0 ? this.stats.cacheHits / totalCache : 0;
    metrics.push(`pow_cache_hit_rate ${hitRate.toFixed(4)}`);

    metrics.push(`pow_uptime_seconds ${Math.floor((Date.now() - this.stats.startTime) / 1000)}`);

    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics.join('\n') + '\n');
  }

  async start() {
    await this.initialize();

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, (error) => {
        if (error) {
          log.error(`Failed to start: ${error.message}`);
          reject(error);
        } else {
          log.info(`POW service listening on port ${this.port}`);
          resolve();
        }
      });
    });
  }

  async stop() {
    log.info('Stopping POW service...');

    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
    }
    if (this.workerPool && typeof this.workerPool.shutdown === 'function') {
      await this.workerPool.shutdown();
    }
    if (this.redisClient) {
      await this.redisClient.close();
    }

    log.info('POW service stopped');
  }
}

// Start if run directly
if (require.main === module) {
  const service = new POWService();

  const shutdown = async (signal) => {
    log.info(`Received ${signal} — shutting down...`);
    try {
      await service.stop();
      process.exit(0);
    } catch (error) {
      log.error(`Shutdown error: ${error.message}`);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  service.start().catch((error) => {
    log.error(`Startup failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = POWService;
