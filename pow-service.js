/**
 * =============================================================================
 * POW SERVICE - Standalone Proof-of-Work Computation Microservice
 * =============================================================================
 * 
 * HTTP API for offloading CPU-intensive POW computation from workers.
 * Features:
 * - POST /compute endpoint with request validation
 * - GET /health endpoint with cache statistics
 * - GET /metrics endpoint with Prometheus format
 * - Redis caching layer with 5-minute TTL
 * - Worker thread pool for parallel computation
 * - Timeout handling (5 seconds per computation)
 * 
 * Requirements: 3.1, 3.2, 10.3, 13.6
 * =============================================================================
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { createLogger } = require('./logger');
const { getRedisClient } = require('./shared/redis/client');
const { validateEnvironment } = require('./shared/config/environment');

const log = createLogger('pow-service');

class POWService {
  constructor(options = {}) {
    this.port = options.port || process.env.PORT || 3001;
    this.redisClient = null;
    this.workerPool = null;
    this.app = express();
    this.server = null;
    
    // Statistics
    this.stats = {
      requestsTotal: 0,
      requestsSuccess: 0,
      requestsError: 0,
      cacheHits: 0,
      cacheMisses: 0,
      computeTimeTotal: 0,
      startTime: Date.now()
    };
    
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Set up Express middleware
   */
  setupMiddleware() {
    // Security and performance middleware
    this.app.use(helmet());
    this.app.use(cors());
    this.app.use(compression());
    this.app.use(express.json({ limit: '1mb' }));
    
    // Request logging middleware
    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        log.info('HTTP request', {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration,
          userAgent: req.get('User-Agent')
        });
      });
      next();
    });
  }

  /**
   * Set up API routes
   */
  setupRoutes() {
    // POST /compute - Compute POW cres value
    this.app.post('/compute', async (req, res) => {
      try {
        await this.handleComputeRequest(req, res);
      } catch (error) {
        log.error('Compute request error', { error: error.message, stack: error.stack });
        res.status(500).json({
          error: 'INTERNAL_ERROR',
          message: 'Internal server error'
        });
      }
    });

    // GET /health - Health check with cache statistics
    this.app.get('/health', async (req, res) => {
      try {
        await this.handleHealthRequest(req, res);
      } catch (error) {
        log.error('Health check error', { error: error.message });
        res.status(500).json({
          status: 'unhealthy',
          error: error.message
        });
      }
    });

    // GET /metrics - Prometheus metrics
    this.app.get('/metrics', async (req, res) => {
      try {
        await this.handleMetricsRequest(req, res);
      } catch (error) {
        log.error('Metrics request error', { error: error.message });
        res.status(500).send('# Error generating metrics\n');
      }
    });

    // GET / - Service info
    this.app.get('/', (req, res) => {
      res.json({
        service: 'POW Service',
        version: '1.0.0',
        status: 'running',
        endpoints: {
          compute: 'POST /compute',
          health: 'GET /health',
          metrics: 'GET /metrics'
        }
      });
    });

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: `Endpoint ${req.method} ${req.path} not found`
      });
    });

    // Error handler
    this.app.use((error, req, res, next) => {
      log.error('Unhandled error', { error: error.message, stack: error.stack });
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Internal server error'
      });
    });
  }

  /**
   * Handle POST /compute request
   */
  async handleComputeRequest(req, res) {
    const startTime = Date.now();
    this.stats.requestsTotal++;

    // Validate request body
    const { mask, key, seed } = req.body;
    
    if (!mask || !key || seed === undefined) {
      this.stats.requestsError++;
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'Missing required fields: mask, key, seed',
        required: ['mask', 'key', 'seed']
      });
    }

    // Validate field types
    if (typeof mask !== 'string' || typeof key !== 'string' || typeof seed !== 'number') {
      this.stats.requestsError++;
      return res.status(400).json({
        error: 'INVALID_TYPES',
        message: 'Invalid field types: mask and key must be strings, seed must be number'
      });
    }

    // Validate field lengths
    if (mask.length > 32 || key.length > 32) {
      this.stats.requestsError++;
      return res.status(400).json({
        error: 'INVALID_LENGTH',
        message: 'mask and key must be <= 32 characters'
      });
    }

    try {
      // Check Redis cache first
      const cacheKey = `pow:${mask}:${key}:${seed}`;
      let cached = false;
      let cres = null;

      if (this.redisClient) {
        try {
          cres = await this.redisClient.executeCommand('get', cacheKey);
          if (cres) {
            cached = true;
            this.stats.cacheHits++;
            log.debug('Cache hit', { cacheKey, cres });
          } else {
            this.stats.cacheMisses++;
          }
        } catch (redisError) {
          log.warn('Redis cache lookup failed', { error: redisError.message });
          this.stats.cacheMisses++;
        }
      } else {
        this.stats.cacheMisses++;
      }

      // If not cached, compute using worker pool
      if (!cres) {
        if (!this.workerPool) {
          throw new Error('Worker pool not initialized');
        }

        const result = await this.workerPool.solve({ mask, key, seed });
        cres = result.stringToHash;

        // Cache the result in Redis with 5-minute TTL
        if (this.redisClient) {
          try {
            await this.redisClient.executeCommand('setex', cacheKey, 300, cres);
            log.debug('Cached result', { cacheKey, cres, ttl: 300 });
          } catch (redisError) {
            log.warn('Redis cache store failed', { error: redisError.message });
          }
        }
      }

      const computeTimeMs = Date.now() - startTime;
      this.stats.requestsSuccess++;
      this.stats.computeTimeTotal += computeTimeMs;

      // Log statistics every 100 requests if cache hit rate > 60%
      if (this.stats.requestsTotal % 100 === 0) {
        const cacheHitRate = this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses);
        if (cacheHitRate > 0.6) {
          log.info('POW cache statistics', {
            requests: this.stats.requestsTotal,
            cacheHitRate: (cacheHitRate * 100).toFixed(1) + '%',
            avgComputeTime: Math.round(this.stats.computeTimeTotal / this.stats.requestsSuccess)
          });
        }
      }

      res.json({
        cres,
        cached,
        computeTimeMs
      });

    } catch (error) {
      this.stats.requestsError++;
      
      if (error.message.includes('timeout') || error.message.includes('POW task')) {
        log.warn('POW computation timeout', { mask, key, seed, error: error.message });
        return res.status(408).json({
          error: 'POW_TIMEOUT',
          message: 'POW computation timed out'
        });
      }

      if (error.code === 'POW_QUEUE_FULL') {
        log.warn('POW queue full', { mask, key, seed, queueDepth: this.workerPool?.taskQueue?.length });
        return res.status(503).json({
          error: 'POW_OVERLOADED',
          message: 'POW service is overloaded, try again later'
        });
      }

      if (error.code === 'POW_FAILED' || error.code === 'POW_MAX_ITERATIONS') {
        log.warn('POW computation failed', { mask, key, seed, error: error.message });
        return res.status(422).json({
          error: 'POW_FAILED',
          message: 'POW computation failed to find solution'
        });
      }

      log.error('POW computation error', { mask, key, seed, error: error.message });
      res.status(500).json({
        error: 'COMPUTATION_ERROR',
        message: 'Failed to compute POW'
      });
    }
  }

  /**
   * Handle GET /health request
   */
  async handleHealthRequest(req, res) {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: Date.now() - this.stats.startTime,
      version: '1.0.0'
    };

    // Check Redis connection
    if (this.redisClient) {
      try {
        const isHealthy = await this.redisClient.isHealthy();
        health.redis = {
          status: isHealthy ? 'connected' : 'disconnected',
          metrics: this.redisClient.getMetrics()
        };
      } catch (error) {
        health.redis = {
          status: 'error',
          error: error.message
        };
        health.status = 'degraded';
      }
    } else {
      health.redis = { status: 'not_configured' };
      health.status = 'degraded';
    }

    // Check worker pool
    if (this.workerPool) {
      try {
        const poolStats = this.workerPool.getStats();
        health.workerPool = {
          status: poolStats.workers.alive > 0 ? 'healthy' : 'unhealthy',
          workers: poolStats.workers,
          queue: poolStats.queue,
          pending: poolStats.pending
        };
        
        if (poolStats.workers.alive === 0) {
          health.status = 'unhealthy';
        }
      } catch (error) {
        health.workerPool = {
          status: 'error',
          error: error.message
        };
        health.status = 'unhealthy';
      }
    } else {
      health.workerPool = { status: 'not_initialized' };
      health.status = 'unhealthy';
    }

    // Cache statistics
    const totalCacheRequests = this.stats.cacheHits + this.stats.cacheMisses;
    health.cache = {
      hitRate: totalCacheRequests > 0 ? 
        ((this.stats.cacheHits / totalCacheRequests) * 100).toFixed(2) + '%' : '0%',
      hits: this.stats.cacheHits,
      misses: this.stats.cacheMisses
    };

    // Request statistics
    health.requests = {
      total: this.stats.requestsTotal,
      success: this.stats.requestsSuccess,
      errors: this.stats.requestsError,
      successRate: this.stats.requestsTotal > 0 ? 
        ((this.stats.requestsSuccess / this.stats.requestsTotal) * 100).toFixed(2) + '%' : '0%'
    };

    // Performance statistics
    health.performance = {
      avgComputeTimeMs: this.stats.requestsSuccess > 0 ? 
        Math.round(this.stats.computeTimeTotal / this.stats.requestsSuccess) : 0
    };

    const statusCode = health.status === 'healthy' ? 200 : 
                      health.status === 'degraded' ? 200 : 503;

    res.status(statusCode).json(health);
  }

  /**
   * Handle GET /metrics request (Prometheus format)
   */
  async handleMetricsRequest(req, res) {
    const metrics = [];
    
    // Request metrics
    metrics.push('# HELP pow_requests_total Total number of POW requests');
    metrics.push('# TYPE pow_requests_total counter');
    metrics.push(`pow_requests_total{status="success"} ${this.stats.requestsSuccess}`);
    metrics.push(`pow_requests_total{status="error"} ${this.stats.requestsError}`);
    
    // Cache metrics
    metrics.push('# HELP pow_cache_hit_rate POW cache hit rate');
    metrics.push('# TYPE pow_cache_hit_rate gauge');
    const totalCacheRequests = this.stats.cacheHits + this.stats.cacheMisses;
    const cacheHitRate = totalCacheRequests > 0 ? this.stats.cacheHits / totalCacheRequests : 0;
    metrics.push(`pow_cache_hit_rate ${cacheHitRate.toFixed(4)}`);
    
    // Computation duration metrics
    metrics.push('# HELP pow_computation_duration_seconds POW computation duration');
    metrics.push('# TYPE pow_computation_duration_seconds histogram');
    const avgDuration = this.stats.requestsSuccess > 0 ? 
      (this.stats.computeTimeTotal / this.stats.requestsSuccess) / 1000 : 0;
    metrics.push(`pow_computation_duration_seconds_sum ${(this.stats.computeTimeTotal / 1000).toFixed(3)}`);
    metrics.push(`pow_computation_duration_seconds_count ${this.stats.requestsSuccess}`);
    metrics.push(`pow_computation_duration_seconds{quantile="0.5"} ${avgDuration.toFixed(3)}`);
    metrics.push(`pow_computation_duration_seconds{quantile="0.95"} ${(avgDuration * 1.5).toFixed(3)}`);
    
    // Worker pool metrics
    if (this.workerPool) {
      try {
        const poolStats = this.workerPool.getStats();
        
        metrics.push('# HELP pow_workers_active Number of active workers');
        metrics.push('# TYPE pow_workers_active gauge');
        metrics.push(`pow_workers_active ${poolStats.workers.active}`);
        
        metrics.push('# HELP pow_workers_total Total number of workers');
        metrics.push('# TYPE pow_workers_total gauge');
        metrics.push(`pow_workers_total ${poolStats.workers.total}`);
        
        metrics.push('# HELP pow_queue_depth Number of queued tasks');
        metrics.push('# TYPE pow_queue_depth gauge');
        metrics.push(`pow_queue_depth ${poolStats.queue}`);
        
        metrics.push('# HELP pow_tasks_completed_total Total completed tasks');
        metrics.push('# TYPE pow_tasks_completed_total counter');
        metrics.push(`pow_tasks_completed_total ${poolStats.tasks.completed}`);
        
        metrics.push('# HELP pow_tasks_failed_total Total failed tasks');
        metrics.push('# TYPE pow_tasks_failed_total counter');
        metrics.push(`pow_tasks_failed_total ${poolStats.tasks.failed}`);
      } catch (error) {
        log.warn('Failed to get worker pool stats for metrics', { error: error.message });
      }
    }
    
    // Service uptime
    metrics.push('# HELP pow_uptime_seconds Service uptime in seconds');
    metrics.push('# TYPE pow_uptime_seconds gauge');
    metrics.push(`pow_uptime_seconds ${Math.floor((Date.now() - this.stats.startTime) / 1000)}`);
    
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics.join('\n') + '\n');
  }

  /**
   * Initialize the POW service
   */
  async initialize() {
    log.info('Initializing POW service...');

    // Validate environment
    const { config } = validateEnvironment('pow-service');
    
    // Initialize Redis client
    if (config.REDIS_URL) {
      try {
        this.redisClient = getRedisClient();
        await this.redisClient.connect();
        log.info('Redis connected successfully');
      } catch (error) {
        log.error('Redis connection failed', { error: error.message });
        throw error;
      }
    } else {
      log.warn('REDIS_URL not configured - running without cache');
    }

    // Initialize worker pool with configurable timeout and worker count
    try {
      const { PowWorkerPool } = require('./automation/http/fingerprinting/powWorkerPool');
      const numWorkers = parseInt(process.env.POW_NUM_WORKERS, 10) || undefined; // undefined = auto (CPU - 1)
      const taskTimeout = parseInt(process.env.POW_TASK_TIMEOUT, 10) || 10000; // 10s default (was 5s)
      
      this.workerPool = new PowWorkerPool({
        numWorkers,
        taskTimeout,
        maxIterations: 8000000 // 8M iterations max
      });
      
      log.info('Worker pool config', { numWorkers: numWorkers || 'auto', taskTimeout });

      // Eagerly spawn workers so health is green without waiting for the first request
      this.workerPool.init();
      log.info('Worker pool initialized and workers spawned');
    } catch (error) {
      log.error('Worker pool initialization failed', { error: error.message });
      throw error;
    }

    log.info('POW service initialization complete');
  }

  /**
   * Start the HTTP server
   */
  async start() {
    await this.initialize();

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, (error) => {
        if (error) {
          log.error('Failed to start POW service', { error: error.message, port: this.port });
          reject(error);
        } else {
          log.info('POW service started', { 
            port: this.port,
            endpoints: {
              compute: `http://localhost:${this.port}/compute`,
              health: `http://localhost:${this.port}/health`,
              metrics: `http://localhost:${this.port}/metrics`
            }
          });
          resolve();
        }
      });
    });
  }

  /**
   * Stop the HTTP server gracefully
   */
  async stop() {
    log.info('Stopping POW service...');

    // Close HTTP server
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(resolve);
      });
      log.info('HTTP server stopped');
    }

    // Shutdown worker pool
    if (this.workerPool && typeof this.workerPool.shutdown === 'function') {
      await this.workerPool.shutdown();
      log.info('Worker pool shutdown');
    }

    // Close Redis connection
    if (this.redisClient) {
      await this.redisClient.close();
      log.info('Redis connection closed');
    }

    log.info('POW service stopped gracefully');
  }
}

// If running as main module, start the service
if (require.main === module) {
  const service = new POWService();
  
  // Graceful shutdown handlers
  process.on('SIGTERM', async () => {
    log.info('Received SIGTERM, shutting down gracefully...');
    try {
      await service.stop();
      process.exit(0);
    } catch (error) {
      log.error('Error during shutdown', { error: error.message });
      process.exit(1);
    }
  });

  process.on('SIGINT', async () => {
    log.info('Received SIGINT, shutting down gracefully...');
    try {
      await service.stop();
      process.exit(0);
    } catch (error) {
      log.error('Error during shutdown', { error: error.message });
      process.exit(1);
    }
  });

  // Start the service
  service.start().catch((error) => {
    log.error('Failed to start POW service', { error: error.message });
    process.exit(1);
  });
}

module.exports = POWService;