/**
 * Backward Compatibility and Fallback Integration
 * 
 * Main entry point for backward compatibility features:
 * - Single-node mode detection and fallback
 * - Graceful degradation for service unavailability
 * - Environment variable compatibility
 * 
 * Requirements: 9.2, 9.3, 9.4, 9.6, 3.7
 */

const { createLogger } = require('../../logger');
const { SingleNodeMode } = require('./SingleNodeMode');
const { GracefulDegradation } = require('./GracefulDegradation');
const { validateEnvironment, getDeploymentMode, isSingleNodeMode } = require('../config/environment');

const log = createLogger('compatibility');

class CompatibilityLayer {
  constructor() {
    this.mode = null;
    this.components = null;
    this.degradation = null;
  }

  /**
   * Initialize compatibility layer based on environment
   * @param {Object} options - Configuration options
   * @returns {Promise<Object>} Initialized components
   */
  async initialize(options = {}) {
    try {
      // Validate environment and determine mode
      const { config, mode, warnings } = validateEnvironment('auto');
      this.mode = mode;
      
      log.info(`Initializing compatibility layer for ${mode} mode`);
      
      // Log any environment warnings
      if (warnings.length > 0) {
        warnings.forEach(warning => log.warn(warning));
      }
      
      // Initialize based on mode
      if (mode === 'single' || isSingleNodeMode()) {
        return await this.initializeSingleNodeMode(config, options);
      } else {
        return await this.initializeDistributedMode(config, options);
      }
      
    } catch (error) {
      log.error('Failed to initialize compatibility layer', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Initialize single-node mode with compatibility wrappers
   * @param {Object} config - Environment configuration
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Single-node components
   */
  async initializeSingleNodeMode(config, options) {
    log.info('Initializing single-node mode with backward compatibility');
    
    // Create graceful degradation layer
    this.degradation = new GracefulDegradation();
    this.degradation.startMonitoring();
    
    // Initialize single-node components
    const singleNodeComponents = SingleNodeMode.createCompatibilityWrapper();
    
    // Create wrapped components with degradation
    this.components = {
      mode: 'single',
      config,
      
      // Core components (single-node implementations)
      jobQueue: singleNodeComponents.jobQueue,
      coordinator: singleNodeComponents.coordinator,
      progressTracker: singleNodeComponents.progressTracker,
      channelForwarder: singleNodeComponents.channelForwarder,
      
      // Degradation wrappers
      degradation: this.degradation,
      
      // Wrapper functions
      wrapTelegram: (telegram) => this.degradation.createTelegramWrapper(telegram),
      wrapPowService: (powClient) => this.degradation.createPowServiceWrapper(powClient),
      
      // Compatibility helpers
      isDistributed: () => false,
      isSingleNode: () => true,
      getMode: () => 'single',
      
      // Legacy support
      processCredentialBatch: async (credentials, options = {}) => {
        return await this.processBatchLegacy(credentials, options);
      }
    };
    
    log.info('Single-node mode initialized successfully');
    return this.components;
  }

  /**
   * Initialize single-node mode as fallback (even when Redis is available)
   * @param {Object} config - Environment configuration
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Single-node components
   */
  async initializeSingleNodeFallback(config, options) {
    log.info('Initializing single-node mode as fallback (Redis available but distributed mode failed)');
    
    // Create graceful degradation layer
    this.degradation = new GracefulDegradation();
    this.degradation.startMonitoring();
    
    // Force single-node components even when Redis is available
    const singleNodeComponents = SingleNodeMode.createCompatibilityWrapper(true); // Force mode
    
    // Create wrapped components with degradation
    this.components = {
      mode: 'single-fallback',
      config,
      
      // Core components (single-node implementations)
      jobQueue: singleNodeComponents.jobQueue,
      coordinator: singleNodeComponents.coordinator,
      progressTracker: singleNodeComponents.progressTracker,
      channelForwarder: singleNodeComponents.channelForwarder,
      
      // Degradation wrappers
      degradation: this.degradation,
      
      // Wrapper functions
      wrapTelegram: (telegram) => this.degradation.createTelegramWrapper(telegram),
      wrapPowService: (powClient) => this.degradation.createPowServiceWrapper(powClient),
      
      // Compatibility helpers
      isDistributed: () => false,
      isSingleNode: () => true,
      getMode: () => 'single-fallback',
      
      // Legacy support
      processCredentialBatch: async (credentials, options = {}) => {
        return await this.processBatchLegacy(credentials, options);
      }
    };
    
    log.info('Single-node fallback mode initialized successfully');
    return this.components;
  }

  /**
   * Initialize distributed mode with fallback capabilities
   * @param {Object} config - Environment configuration
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Distributed components with fallbacks
   */
  async initializeDistributedMode(config, options) {
    log.info(`Initializing distributed mode: ${this.mode}`);
    
    // Create graceful degradation layer
    this.degradation = new GracefulDegradation();
    this.degradation.startMonitoring();
    
    try {
      // Try to initialize distributed components
      const { getRedisClient } = require('../redis/client');
      const redisClient = getRedisClient();
      
      // Test Redis connectivity
      await this.degradation.checkRedisAvailability(
        () => redisClient.executeCommand('ping')
      );
      
      // Initialize distributed components based on mode
      let components;
      
      if (this.mode === 'coordinator') {
        components = await this.initializeCoordinator(redisClient, config, options);
      } else if (this.mode === 'worker') {
        components = await this.initializeWorker(redisClient, config, options);
      } else if (this.mode === 'pow-service') {
        components = await this.initializePowService(config, options);
      } else {
        throw new Error(`Unknown distributed mode: ${this.mode}`);
      }
      
      // Wrap components with degradation
      this.components = {
        ...components,
        mode: this.mode,
        config,
        degradation: this.degradation,
        
        // Wrapper functions
        wrapTelegram: (telegram) => this.degradation.createTelegramWrapper(telegram),
        wrapRedis: (redis) => this.degradation.createRedisWrapper(redis),
        wrapPowService: (powClient) => this.degradation.createPowServiceWrapper(powClient),
        
        // Compatibility helpers
        isDistributed: () => true,
        isSingleNode: () => false,
        getMode: () => this.mode
      };
      
      log.info(`Distributed mode (${this.mode}) initialized successfully`);
      return this.components;
      
    } catch (error) {
      log.warn('Distributed mode initialization failed, falling back to single-node', {
        error: error.message
      });
      
      // Force fallback to single-node mode even when Redis is available
      // This handles cases where Redis is available but distributed mode fails
      return await this.initializeSingleNodeFallback(config, options);
    }
  }

  /**
   * Initialize coordinator components
   * @param {Object} redisClient - Redis client
   * @param {Object} config - Configuration
   * @param {Object} options - Options
   * @returns {Promise<Object>} Coordinator components
   */
  async initializeCoordinator(redisClient, config, options) {
    const { Coordinator, ProxyPoolManager } = require('../coordinator');
    
    // Initialize coordinator with configuration (telegram will be set later)
    const coordinator = new Coordinator(redisClient, null, {
      proxies: config.PROXY_POOL || [],
      channelId: config.FORWARD_CHANNEL_ID,
      metrics: {
        port: config.METRICS_PORT,
        enabled: true
      }
    });
    
    // Start the coordinator (pub/sub listeners, heartbeats, monitoring)
    await coordinator.start();
    
    return {
      coordinator,
      jobQueue: coordinator.jobQueue,
      progressTracker: coordinator.progressTracker,
      channelForwarder: coordinator.channelForwarder,
      proxyPool: coordinator.proxyPool,
      metricsManager: coordinator.metricsManager,
      
      // Method to set telegram instance after it's created
      setTelegram: (telegram) => {
        coordinator.telegram = telegram;
        coordinator.progressTracker.telegram = telegram;
        coordinator.channelForwarder.telegram = telegram;
      }
    };
  }

  /**
   * Initialize worker components
   * @param {Object} redisClient - Redis client
   * @param {Object} config - Configuration
   * @param {Object} options - Options
   * @returns {Promise<Object>} Worker components
   */
  async initializeWorker(redisClient, config, options) {
    const { WorkerNode } = require('../worker');
    
    // Initialize worker with configuration
    const worker = new WorkerNode(redisClient, {
      workerId: config.WORKER_ID,
      powServiceUrl: config.POW_SERVICE_URL,
      taskTimeout: config.BATCH_TIMEOUT_MS,
      concurrency: config.WORKER_CONCURRENCY
    });
    
    return {
      worker,
      
      // Start worker processing
      start: async () => {
        return await worker.run();
      },
      
      // Stop worker
      stop: async () => {
        return await worker.handleShutdown();
      }
    };
  }

  /**
   * Initialize POW service components
   * @param {Object} config - Configuration
   * @param {Object} options - Options
   * @returns {Promise<Object>} POW service components
   */
  async initializePowService(config, options) {
    // POW service initialization would go here
    // For now, return a placeholder
    return {
      powService: {
        start: async () => {
          log.info('POW service would start here');
        },
        stop: async () => {
          log.info('POW service would stop here');
        }
      }
    };
  }

  /**
   * Process credential batch using legacy single-node logic
   * @param {Array} credentials - Credentials to process
   * @param {Object} options - Processing options
   * @returns {Promise<Object>} Processing results
   */
  async processBatchLegacy(credentials, options = {}) {
    const { checkCredentials } = require('../../httpChecker');
    const { markProcessedStatus } = require('../../automation/batch/processedStore');
    
    const results = [];
    const concurrency = options.concurrency || parseInt(process.env.BATCH_CONCURRENCY, 10) || 1;
    
    log.info(`Processing ${credentials.length} credentials with concurrency ${concurrency}`);
    
    // Process in chunks
    for (let i = 0; i < credentials.length; i += concurrency) {
      const chunk = credentials.slice(i, i + concurrency);
      
      const chunkPromises = chunk.map(async (credential) => {
        try {
          const result = await checkCredentials(credential.username, credential.password, {
            proxy: options.proxy || process.env.PROXY_SERVER,
            timeoutMs: options.timeoutMs || parseInt(process.env.TIMEOUT_MS, 10) || 60000
          });
          
          // Store in processed cache
          await markProcessedStatus(
            `${credential.username}:${credential.password}`,
            result.status
          );
          
          return {
            username: credential.username,
            password: credential.password,
            status: result.status,
            capture: result.capture,
            ipAddress: result.ipAddress,
            checkedAt: Date.now()
          };
          
        } catch (error) {
          log.error(`Failed to check credential ${credential.username}`, {
            error: error.message
          });
          
          return {
            username: credential.username,
            password: credential.password,
            status: 'ERROR',
            errorCode: error.message,
            checkedAt: Date.now()
          };
        }
      });
      
      const chunkResults = await Promise.all(chunkPromises);
      results.push(...chunkResults);
      
      // Progress callback
      if (options.onProgress) {
        await options.onProgress(results.length, credentials.length);
      }
      
      // Delay between chunks
      if (i + concurrency < credentials.length) {
        const delay = options.delay || parseInt(process.env.BATCH_DELAY_MS, 10) || 50;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    return {
      results,
      summary: {
        total: credentials.length,
        valid: results.filter(r => r.status === 'VALID').length,
        invalid: results.filter(r => r.status === 'INVALID').length,
        blocked: results.filter(r => r.status === 'BLOCKED').length,
        error: results.filter(r => r.status === 'ERROR').length
      }
    };
  }

  /**
   * Get compatibility status
   * @returns {Object} Status information
   */
  getStatus() {
    return {
      mode: this.mode,
      initialized: Boolean(this.components),
      degradation: this.degradation ? this.degradation.getDegradationStatus() : null,
      features: {
        singleNodeFallback: true,
        gracefulDegradation: true,
        environmentCompatibility: true,
        legacySupport: true
      }
    };
  }

  /**
   * Shutdown compatibility layer
   */
  async shutdown() {
    if (this.components) {
      if (this.components.coordinator && typeof this.components.coordinator.stop === 'function') {
        await this.components.coordinator.stop();
      }
      
      if (this.components.worker && typeof this.components.worker.stop === 'function') {
        await this.components.worker.stop();
      }
      
      if (this.components.jobQueue && typeof this.components.jobQueue.stop === 'function') {
        await this.components.jobQueue.stop();
      }
    }
    
    log.info('Compatibility layer shutdown complete');
  }
}

/**
 * Create and initialize compatibility layer
 * @param {Object} options - Configuration options
 * @returns {Promise<Object>} Initialized compatibility layer
 */
async function createCompatibilityLayer(options = {}) {
  const layer = new CompatibilityLayer();
  const components = await layer.initialize(options);
  
  return {
    ...components,
    layer,
    shutdown: () => layer.shutdown(),
    getStatus: () => layer.getStatus()
  };
}

module.exports = {
  CompatibilityLayer,
  createCompatibilityLayer,
  SingleNodeMode,
  GracefulDegradation
};