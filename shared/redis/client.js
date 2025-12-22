/**
 * Redis Client Wrapper with Connection Pooling and Retry Logic
 * 
 * Provides a robust Redis client with:
 * - Connection pooling for high throughput
 * - Exponential backoff retry logic
 * - Graceful error handling and reconnection
 * - Health monitoring and metrics
 */

const Redis = require('ioredis');
const { createLogger } = require('../../logger');

const log = createLogger('redis-client');

class RedisClient {
  constructor(options = {}) {
    this.options = {
      // Connection settings
      host: options.host || process.env.REDIS_HOST || 'localhost',
      port: options.port || process.env.REDIS_PORT || 6379,
      password: options.password || process.env.REDIS_PASSWORD,
      db: options.db || process.env.REDIS_DB || 0,
      
      // Connection pooling
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 100,
      lazyConnect: true,
      keepAlive: 30000,
      
      // Retry logic - exponential backoff: 1s, 2s, 4s, 8s, 16s max
      retryDelayOnClusterDown: 300,
      maxRetriesPerRequest: 5,
      
      // Connection timeout
      connectTimeout: 10000,
      commandTimeout: parseInt(process.env.REDIS_COMMAND_TIMEOUT, 10) || 60000, // Configurable, default 60s
      
      // Override with provided options
      ...options
    };

    this.client = null;
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 5;
    this.reconnectDelay = 1000; // Start with 1 second
    this.maxReconnectDelay = 16000; // Max 16 seconds
    
    // Metrics
    this.metrics = {
      connectionAttempts: 0,
      successfulConnections: 0,
      failedConnections: 0,
      commandsExecuted: 0,
      commandsFailed: 0,
      lastConnectionTime: null,
      lastErrorTime: null
    };
  }

  /**
   * Initialize Redis connection with retry logic
   */
  async connect() {
    if (this.isConnected && this.client) {
      return this.client;
    }

    // Parse Redis URL if provided
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      // When using Redis URL, ensure options are properly merged
      this.client = new Redis(redisUrl, {
        ...this.options,
        // Explicitly set critical timeout options
        commandTimeout: this.options.commandTimeout,
        connectTimeout: this.options.connectTimeout,
        lazyConnect: this.options.lazyConnect
      });
    } else {
      this.client = new Redis(this.options);
    }

    // Set up event handlers
    this.setupEventHandlers();

    try {
      await this.client.connect();
      this.isConnected = true;
      this.connectionAttempts = 0;
      this.reconnectDelay = 1000; // Reset delay on successful connection
      this.metrics.successfulConnections++;
      this.metrics.lastConnectionTime = Date.now();
      
      log.info('Redis connected successfully', {
        host: this.options.host,
        port: this.options.port,
        db: this.options.db,
        commandTimeout: this.options.commandTimeout,
        connectTimeout: this.options.connectTimeout
      });
      
      return this.client;
    } catch (error) {
      this.metrics.failedConnections++;
      this.metrics.lastErrorTime = Date.now();
      
      log.error('Redis connection failed', { 
        error: error.message,
        attempt: this.connectionAttempts + 1,
        maxAttempts: this.maxConnectionAttempts
      });
      
      throw error;
    }
  }

  /**
   * Set up Redis event handlers for monitoring and reconnection
   */
  setupEventHandlers() {
    this.client.on('connect', () => {
      this.isConnected = true;
      log.info('Redis connected');
    });

    this.client.on('ready', () => {
      log.info('Redis ready for commands');
    });

    this.client.on('error', (error) => {
      this.isConnected = false;
      this.metrics.lastErrorTime = Date.now();
      log.error('Redis error', { error: error.message });
    });

    this.client.on('close', () => {
      this.isConnected = false;
      log.warn('Redis connection closed');
    });

    this.client.on('reconnecting', (delay) => {
      log.info('Redis reconnecting', { delay });
    });

    this.client.on('end', () => {
      this.isConnected = false;
      log.warn('Redis connection ended');
    });
  }

  /**
   * Reconnect with exponential backoff
   */
  async reconnect() {
    if (this.connectionAttempts >= this.maxConnectionAttempts) {
      const error = new Error(`Max reconnection attempts (${this.maxConnectionAttempts}) exceeded`);
      log.error('Redis reconnection failed', { error: error.message });
      throw error;
    }

    this.connectionAttempts++;
    this.metrics.connectionAttempts++;

    log.info('Attempting Redis reconnection', {
      attempt: this.connectionAttempts,
      delay: this.reconnectDelay
    });

    // Wait with exponential backoff
    await new Promise(resolve => setTimeout(resolve, this.reconnectDelay));

    try {
      await this.connect();
      return this.client;
    } catch (error) {
      // Exponential backoff: double the delay, up to max
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      throw error;
    }
  }

  /**
   * Execute Redis command with automatic retry on connection failure
   */
  async executeCommand(command, ...args) {
    if (!this.client || !this.isConnected) {
      await this.connect();
    }

    try {
      this.metrics.commandsExecuted++;
      const result = await this.client[command](...args);
      return result;
    } catch (error) {
      this.metrics.commandsFailed++;
      
      // If connection error, try to reconnect once
      if (error.message.includes('Connection is closed') || 
          error.message.includes('ECONNREFUSED') ||
          error.message.includes('ENOTFOUND')) {
        
        log.warn('Redis command failed due to connection issue, attempting reconnect', {
          command,
          error: error.message
        });
        
        try {
          await this.reconnect();
          this.metrics.commandsExecuted++;
          return await this.client[command](...args);
        } catch (reconnectError) {
          log.error('Redis reconnection failed during command execution', {
            command,
            originalError: error.message,
            reconnectError: reconnectError.message
          });
          throw reconnectError;
        }
      }
      
      // Re-throw non-connection errors
      throw error;
    }
  }

  /**
   * Get Redis client instance (for direct access when needed)
   */
  getClient() {
    return this.client;
  }

  /**
   * Check if Redis is connected and healthy
   */
  async isHealthy() {
    try {
      if (!this.client || !this.isConnected) {
        return false;
      }
      
      // Use a shorter timeout for health checks
      const healthTimeout = 5000;
      const result = await Promise.race([
        this.client.ping(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Health check timeout')), healthTimeout)
        )
      ]);
      
      return result === 'PONG';
    } catch (error) {
      log.debug('Redis health check failed', { error: error.message });
      return false;
    }
  }

  /**
   * Get connection metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      isConnected: this.isConnected,
      connectionAttempts: this.connectionAttempts,
      reconnectDelay: this.reconnectDelay
    };
  }

  /**
   * Gracefully close Redis connection
   */
  async close() {
    if (this.client) {
      try {
        await this.client.quit();
        log.info('Redis connection closed gracefully');
      } catch (error) {
        log.warn('Error closing Redis connection', { error: error.message });
      } finally {
        this.client = null;
        this.isConnected = false;
      }
    }
  }

  /**
   * Force disconnect (for emergency shutdown)
   */
  disconnect() {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
      this.isConnected = false;
      log.info('Redis connection force disconnected');
    }
  }
}

// Singleton instances for shared use
let sharedClient = null;
let sharedPubSubClient = null;

/**
 * Get shared Redis client instance (for regular commands)
 */
function getRedisClient(options = {}) {
  if (!sharedClient) {
    sharedClient = new RedisClient(options);
  }
  return sharedClient;
}

/**
 * Get shared Redis pub/sub client instance (for subscribe/publish operations)
 * This is a separate connection because Redis connections in subscriber mode
 * cannot execute regular commands
 */
function getPubSubClient(options = {}) {
  if (!sharedPubSubClient) {
    sharedPubSubClient = new RedisClient(options);
  }
  return sharedPubSubClient;
}

/**
 * Initialize shared Redis client
 */
async function initRedisClient(options = {}) {
  const client = getRedisClient(options);
  await client.connect();
  return client;
}

/**
 * Initialize shared pub/sub Redis client
 */
async function initPubSubClient(options = {}) {
  const client = getPubSubClient(options);
  await client.connect();
  return client;
}

/**
 * Close shared Redis client
 */
async function closeRedisClient() {
  if (sharedClient) {
    await sharedClient.close();
    sharedClient = null;
  }
}

/**
 * Close shared pub/sub Redis client
 */
async function closePubSubClient() {
  if (sharedPubSubClient) {
    await sharedPubSubClient.close();
    sharedPubSubClient = null;
  }
}

module.exports = {
  RedisClient,
  getRedisClient,
  getPubSubClient,
  initRedisClient,
  initPubSubClient,
  closeRedisClient,
  closePubSubClient
};