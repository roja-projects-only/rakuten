/**
 * Centralized Configuration Service
 * 
 * Manages runtime configuration stored in Redis with automatic propagation
 * to all coordinator/worker instances via pub/sub.
 * 
 * Precedence: Redis > Railway/.env > Schema Default
 */

const { createLogger } = require('../../logger');
const {
  CONFIG_SCHEMA,
  validateValue,
  getEnvDefault,
  getConfigKeys,
  getSchema,
  getKeysByCategory,
  getCategories
} = require('./configSchema');

const log = createLogger('config-service');

// Redis key prefix for config values
const CONFIG_PREFIX = 'config:';
// Pub/sub channel for config updates
const CONFIG_CHANNEL = 'config_updates';

class ConfigService {
  constructor() {
    this.redisClient = null;
    this.pubSubClient = null;
    this.localCache = new Map();
    this.initialized = false;
    this.subscribed = false;
    this.updateCallbacks = [];
  }

  /**
   * Initialize the config service with Redis clients
   * @param {object} redisClient - Redis client for get/set operations
   * @param {object} pubSubClient - Redis client for pub/sub (optional, for subscribers)
   */
  async initialize(redisClient, pubSubClient = null) {
    this.redisClient = redisClient;
    this.pubSubClient = pubSubClient;

    // Load all config values from Redis into local cache
    await this.loadAllFromRedis();

    this.initialized = true;
    log.info('ConfigService initialized', {
      keysLoaded: this.localCache.size,
      hasSubscriber: !!pubSubClient
    });
  }

  /**
   * Load all config values from Redis into local cache
   */
  async loadAllFromRedis() {
    if (!this.redisClient) {
      log.warn('ConfigService: No Redis client, using env/defaults only');
      return;
    }

    try {
      const client = this.redisClient.getClient ? this.redisClient.getClient() : this.redisClient;
      if (!client) {
        log.warn('ConfigService: Redis client not connected');
        return;
      }

      const keys = getConfigKeys();
      
      for (const key of keys) {
        const redisKey = `${CONFIG_PREFIX}${key}`;
        const value = await client.get(redisKey);
        
        if (value !== null) {
          const validation = validateValue(key, value);
          if (validation.valid) {
            this.localCache.set(key, {
              value: validation.parsedValue,
              source: 'redis'
            });
          }
        }
      }

      log.debug('Config loaded from Redis', {
        fromRedis: this.localCache.size,
        total: keys.length
      });
    } catch (error) {
      log.error('Failed to load config from Redis', { error: error.message });
    }
  }

  /**
   * Subscribe to config updates via pub/sub
   * @param {function} callback - Optional callback when config changes
   */
  async subscribe(callback = null) {
    if (callback) {
      this.updateCallbacks.push(callback);
    }

    if (!this.pubSubClient || this.subscribed) {
      return;
    }

    try {
      const client = this.pubSubClient.getClient ? this.pubSubClient.getClient() : this.pubSubClient;
      if (!client) {
        log.warn('ConfigService: Pub/sub client not connected');
        return;
      }

      await client.subscribe(CONFIG_CHANNEL);
      
      client.on('message', (channel, message) => {
        if (channel === CONFIG_CHANNEL) {
          this.handleConfigUpdate(message);
        }
      });

      this.subscribed = true;
      log.info('ConfigService: Subscribed to config updates');
    } catch (error) {
      log.error('Failed to subscribe to config updates', { error: error.message });
    }
  }

  /**
   * Handle incoming config update from pub/sub
   * @param {string} message - JSON message from pub/sub
   */
  handleConfigUpdate(message) {
    try {
      const update = JSON.parse(message);
      const { key, value, action } = update;

      if (!key || !CONFIG_SCHEMA[key]) {
        return;
      }

      if (action === 'set') {
        const validation = validateValue(key, value);
        if (validation.valid) {
          this.localCache.set(key, {
            value: validation.parsedValue,
            source: 'redis'
          });
          log.info('Config updated via pub/sub', { key, value: validation.parsedValue });
        }
      } else if (action === 'reset') {
        this.localCache.delete(key);
        log.info('Config reset via pub/sub', { key });
      }

      // Notify callbacks
      for (const cb of this.updateCallbacks) {
        try {
          cb(key, this.get(key), action);
        } catch (err) {
          log.error('Config update callback error', { error: err.message });
        }
      }
    } catch (error) {
      log.error('Failed to handle config update', { error: error.message, message });
    }
  }

  /**
   * Get a config value
   * Precedence: Redis/cache > env > schema default
   * @param {string} key - Config key
   * @returns {any} Config value
   */
  get(key) {
    // Check local cache first (populated from Redis)
    const cached = this.localCache.get(key);
    if (cached !== undefined) {
      return cached.value;
    }

    // Fall back to env/default
    return getEnvDefault(key);
  }

  /**
   * Get a config value with source information
   * @param {string} key - Config key
   * @returns {{ value: any, source: string }}
   */
  getWithSource(key) {
    const cached = this.localCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const envValue = process.env[key];
    if (envValue !== undefined && envValue !== '') {
      const validation = validateValue(key, envValue);
      if (validation.valid) {
        return { value: validation.parsedValue, source: 'env' };
      }
    }

    const schema = getSchema(key);
    if (schema) {
      return { value: schema.default, source: 'default' };
    }

    return { value: undefined, source: 'unknown' };
  }

  /**
   * Set a config value in Redis and publish update
   * @param {string} key - Config key
   * @param {any} value - New value
   * @returns {{ success: boolean, error?: string }}
   */
  async set(key, value) {
    if (!CONFIG_SCHEMA[key]) {
      return { success: false, error: `Unknown config key: ${key}` };
    }

    const validation = validateValue(key, value);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    if (!this.redisClient) {
      return { success: false, error: 'Redis not available' };
    }

    try {
      const client = this.redisClient.getClient ? this.redisClient.getClient() : this.redisClient;
      if (!client) {
        return { success: false, error: 'Redis client not connected' };
      }

      const redisKey = `${CONFIG_PREFIX}${key}`;
      const stringValue = String(validation.parsedValue);
      
      await client.set(redisKey, stringValue);

      // Update local cache
      this.localCache.set(key, {
        value: validation.parsedValue,
        source: 'redis'
      });

      // Publish update to all instances
      await client.publish(CONFIG_CHANNEL, JSON.stringify({
        key,
        value: stringValue,
        action: 'set',
        timestamp: Date.now()
      }));

      log.info('Config set', { key, value: validation.parsedValue });
      return { success: true, value: validation.parsedValue };
    } catch (error) {
      log.error('Failed to set config', { key, error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Reset a config value to env/default (delete from Redis)
   * @param {string} key - Config key
   * @returns {{ success: boolean, error?: string, value?: any }}
   */
  async reset(key) {
    if (!CONFIG_SCHEMA[key]) {
      return { success: false, error: `Unknown config key: ${key}` };
    }

    if (!this.redisClient) {
      return { success: false, error: 'Redis not available' };
    }

    try {
      const client = this.redisClient.getClient ? this.redisClient.getClient() : this.redisClient;
      if (!client) {
        return { success: false, error: 'Redis client not connected' };
      }

      const redisKey = `${CONFIG_PREFIX}${key}`;
      await client.del(redisKey);

      // Remove from local cache
      this.localCache.delete(key);

      // Publish reset to all instances
      await client.publish(CONFIG_CHANNEL, JSON.stringify({
        key,
        action: 'reset',
        timestamp: Date.now()
      }));

      const newValue = getEnvDefault(key);
      log.info('Config reset', { key, newValue });
      return { success: true, value: newValue };
    } catch (error) {
      log.error('Failed to reset config', { key, error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * List all config keys with values and sources
   * @returns {Array<{ key: string, value: any, source: string, description: string, category: string }>}
   */
  list() {
    const keys = getConfigKeys();
    return keys.map(key => {
      const { value, source } = this.getWithSource(key);
      const schema = getSchema(key);
      return {
        key,
        value,
        source,
        description: schema?.description || '',
        category: schema?.category || 'other',
        type: schema?.type || 'string'
      };
    });
  }

  /**
   * List config by category
   * @param {string} category - Category name
   * @returns {Array}
   */
  listByCategory(category) {
    return this.list().filter(item => item.category === category);
  }

  /**
   * Get all categories
   * @returns {string[]}
   */
  getCategories() {
    return getCategories();
  }

  /**
   * Check if service is initialized
   * @returns {boolean}
   */
  isInitialized() {
    return this.initialized;
  }

  /**
   * Export schema info for help text
   * @returns {object}
   */
  getSchemaInfo() {
    return CONFIG_SCHEMA;
  }
}

// Singleton instance
let instance = null;

/**
 * Get the ConfigService singleton
 * @returns {ConfigService}
 */
function getConfigService() {
  if (!instance) {
    instance = new ConfigService();
  }
  return instance;
}

/**
 * Initialize the ConfigService singleton
 * @param {object} redisClient - Redis client
 * @param {object} pubSubClient - Pub/sub client (optional)
 * @returns {Promise<ConfigService>}
 */
async function initConfigService(redisClient, pubSubClient = null) {
  const service = getConfigService();
  if (!service.isInitialized()) {
    await service.initialize(redisClient, pubSubClient);
  }
  return service;
}

module.exports = {
  ConfigService,
  getConfigService,
  initConfigService,
  CONFIG_CHANNEL
};
