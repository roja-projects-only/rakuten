/**
 * Metrics HTTP Server for Coordinator
 * 
 * Exposes Prometheus metrics endpoint for monitoring and alerting.
 * Lightweight HTTP server that runs alongside the Coordinator.
 * 
 * Requirements: 13.2, 13.3
 */

const http = require('http');
const { createStructuredLogger } = require('../logger/structured');

class MetricsServer {
  constructor(coordinator, options = {}) {
    this.coordinator = coordinator;
    this.logger = createStructuredLogger('metrics-server');
    
    this.port = options.port || process.env.METRICS_PORT || 9090;
    this.host = options.host || process.env.METRICS_HOST || '0.0.0.0';
    
    this.server = null;
    this.isRunning = false;
    
    this.logger.info('MetricsServer initialized', {
      port: this.port,
      host: this.host
    });
  }

  /**
   * Start the HTTP server
   */
  async start() {
    if (this.isRunning) {
      this.logger.warn('Metrics server already running');
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        this.server = http.createServer(this.handleRequest.bind(this));
        
        this.server.listen(this.port, this.host, () => {
          this.isRunning = true;
          this.logger.info('Metrics server started', {
            port: this.port,
            host: this.host,
            url: `http://${this.host}:${this.port}/metrics`
          });
          resolve();
        });
        
        this.server.on('error', (error) => {
          this.logger.error('Metrics server error', {
            error: error.message,
            port: this.port
          });
          reject(error);
        });
        
      } catch (error) {
        this.logger.error('Failed to start metrics server', {
          error: error.message
        });
        reject(error);
      }
    });
  }

  /**
   * Stop the HTTP server
   */
  async stop() {
    if (!this.isRunning || !this.server) {
      this.logger.warn('Metrics server not running');
      return;
    }

    return new Promise((resolve) => {
      this.server.close(() => {
        this.isRunning = false;
        this.server = null;
        this.logger.info('Metrics server stopped');
        resolve();
      });
    });
  }

  /**
   * Handle HTTP requests
   * @param {http.IncomingMessage} req - Request object
   * @param {http.ServerResponse} res - Response object
   */
  async handleRequest(req, res) {
    const startTime = Date.now();
    
    try {
      // Log request
      this.logger.debug('HTTP request received', {
        method: req.method,
        url: req.url,
        userAgent: req.headers['user-agent']
      });
      
      // Set CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      // Handle OPTIONS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }
      
      // Route requests
      if (req.method === 'GET' && req.url === '/metrics') {
        await this.handleMetricsRequest(req, res);
      } else if (req.method === 'GET' && req.url === '/health') {
        await this.handleHealthRequest(req, res);
      } else if (req.method === 'GET' && req.url === '/') {
        await this.handleRootRequest(req, res);
      } else {
        this.handleNotFound(req, res);
      }
      
    } catch (error) {
      this.logger.error('Error handling HTTP request', {
        method: req.method,
        url: req.url,
        error: error.message
      });
      
      this.handleError(req, res, error);
    } finally {
      const duration = Date.now() - startTime;
      this.logger.debug('HTTP request completed', {
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        duration
      });
    }
  }

  /**
   * Handle /metrics endpoint
   */
  async handleMetricsRequest(req, res) {
    try {
      const metrics = await this.coordinator.getMetricsEndpoint();
      
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.writeHead(200);
      res.end(metrics);
      
    } catch (error) {
      this.logger.error('Error generating metrics', {
        error: error.message
      });
      
      res.setHeader('Content-Type', 'text/plain');
      res.writeHead(500);
      res.end(`# Error generating metrics: ${error.message}\n`);
    }
  }

  /**
   * Handle /health endpoint
   */
  async handleHealthRequest(req, res) {
    try {
      const status = await this.coordinator.getSystemStatus();
      
      const health = {
        status: status.coordinator.running ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        coordinator: {
          id: status.coordinator.id,
          uptime: status.coordinator.uptime,
          running: status.coordinator.running
        },
        workers: {
          active: status.workers.active,
          healthy: status.workers.details.filter(w => w.healthy).length
        },
        queue: {
          depth: status.queue.depth || 0
        }
      };
      
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(status.coordinator.running ? 200 : 503);
      res.end(JSON.stringify(health, null, 2));
      
    } catch (error) {
      this.logger.error('Error generating health status', {
        error: error.message
      });
      
      const errorHealth = {
        status: 'error',
        timestamp: new Date().toISOString(),
        error: error.message
      };
      
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(500);
      res.end(JSON.stringify(errorHealth, null, 2));
    }
  }

  /**
   * Handle root endpoint
   */
  async handleRootRequest(req, res) {
    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Distributed Worker Coordinator - Metrics</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .endpoint { margin: 20px 0; padding: 10px; background: #f5f5f5; border-radius: 5px; }
        .endpoint a { text-decoration: none; color: #0066cc; font-weight: bold; }
        .endpoint a:hover { text-decoration: underline; }
        .description { margin-top: 5px; color: #666; }
    </style>
</head>
<body>
    <h1>Distributed Worker Coordinator</h1>
    <p>Metrics and monitoring endpoints for the distributed credential checking system.</p>
    
    <div class="endpoint">
        <a href="/metrics">/metrics</a>
        <div class="description">Prometheus-compatible metrics for monitoring and alerting</div>
    </div>
    
    <div class="endpoint">
        <a href="/health">/health</a>
        <div class="description">Health check endpoint with system status information</div>
    </div>
    
    <hr>
    <p><small>Coordinator ID: ${this.coordinator.coordinatorId}</small></p>
</body>
</html>`;
    
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(html);
  }

  /**
   * Handle 404 Not Found
   */
  handleNotFound(req, res) {
    res.setHeader('Content-Type', 'text/plain');
    res.writeHead(404);
    res.end('Not Found\n');
  }

  /**
   * Handle server errors
   */
  handleError(req, res, error) {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/plain');
      res.writeHead(500);
      res.end('Internal Server Error\n');
    }
  }
}

module.exports = MetricsServer;