/**
 * Environment Variable Validation for Distributed Mode
 * 
 * Validates and provides defaults for all environment variables
 * required by the distributed worker architecture.
 */

const { createLogger } = require('../../logger');

const log = createLogger('config');

/**
 * Environment variable definitions with validation rules
 */
const ENV_DEFINITIONS = {
  // Redis Configuration
  REDIS_URL: {
    required: false, // Required only for coordinator and worker modes
    description: 'Redis connection URL for distributed coordination',
    example: 'redis://localhost:6379',
    validate: (value) => {
      if (!value.startsWith('redis://') && !value.startsWith('rediss://')) {
        throw new Error('REDIS_URL must start with redis:// or rediss://');
      }
      return value;
    }
  },

  REDIS_HOST: {
    required: false,
    default: 'localhost',
    description: 'Redis host (alternative to REDIS_URL)',
    validate: (value) => value
  },

  REDIS_PORT: {
    required: false,
    default: 6379,
    description: 'Redis port (alternative to REDIS_URL)',
    validate: (value) => {
      const port = parseInt(value, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error('REDIS_PORT must be a valid port number (1-65535)');
      }
      return port;
    }
  },

  REDIS_PASSWORD: {
    required: false,
    description: 'Redis password (if required)',
    sensitive: true,
    validate: (value) => value
  },

  REDIS_DB: {
    required: false,
    default: 0,
    description: 'Redis database number',
    validate: (value) => {
      const db = parseInt(value, 10);
      if (isNaN(db) || db < 0 || db > 15) {
        throw new Error('REDIS_DB must be a number between 0-15');
      }
      return db;
    }
  },

  // Worker Configuration
  WORKER_ID: {
    required: false,
    description: 'Unique worker identifier (auto-generated if not set)',
    validate: (value) => value
  },

  WORKER_CONCURRENCY: {
    required: false,
    default: 5,
    description: 'Number of concurrent tasks per worker',
    validate: (value) => {
      const concurrency = parseInt(value, 10);
      if (isNaN(concurrency) || concurrency < 1 || concurrency > 50) {
        throw new Error('WORKER_CONCURRENCY must be between 1-50');
      }
      return concurrency;
    }
  },

  // POW Service Configuration
  POW_SERVICE_URL: {
    required: false,
    description: 'POW service HTTP endpoint',
    example: 'http://pow-service:3001',
    validate: (value) => {
      if (value && !value.startsWith('http://') && !value.startsWith('https://')) {
        throw new Error('POW_SERVICE_URL must start with http:// or https://');
      }
      return value;
    }
  },

  POW_SERVICE_TIMEOUT: {
    required: false,
    default: 5000,
    description: 'POW service request timeout in milliseconds',
    validate: (value) => {
      const timeout = parseInt(value, 10);
      if (isNaN(timeout) || timeout < 1000 || timeout > 30000) {
        throw new Error('POW_SERVICE_TIMEOUT must be between 1000-30000ms');
      }
      return timeout;
    }
  },

  // Coordinator Configuration
  COORDINATOR_MODE: {
    required: false,
    default: false,
    description: 'Enable coordinator mode (Telegram bot + job management)',
    validate: (value) => {
      if (typeof value === 'string') {
        return value.toLowerCase() === 'true' || value === '1';
      }
      return Boolean(value);
    }
  },

  BACKUP_COORDINATOR: {
    required: false,
    default: false,
    description: 'Enable backup coordinator mode (standby for failover)',
    validate: (value) => {
      if (typeof value === 'string') {
        return value.toLowerCase() === 'true' || value === '1';
      }
      return Boolean(value);
    }
  },

  // Batch Processing Configuration
  BATCH_MAX_RETRIES: {
    required: false,
    default: 2,
    description: 'Maximum retry attempts for failed tasks',
    validate: (value) => {
      const retries = parseInt(value, 10);
      if (isNaN(retries) || retries < 0 || retries > 10) {
        throw new Error('BATCH_MAX_RETRIES must be between 0-10');
      }
      return retries;
    }
  },

  BATCH_TIMEOUT_MS: {
    required: false,
    default: 120000,
    description: 'Task timeout in milliseconds (2 minutes default)',
    validate: (value) => {
      const timeout = parseInt(value, 10);
      if (isNaN(timeout) || timeout < 30000 || timeout > 600000) {
        throw new Error('BATCH_TIMEOUT_MS must be between 30000-600000ms (30s-10min)');
      }
      return timeout;
    }
  },

  // Proxy Configuration
  PROXY_POOL: {
    required: false,
    description: 'Comma-separated list of proxy URLs',
    example: 'http://proxy1:8080,http://proxy2:8080',
    validate: (value) => {
      if (!value) return [];
      
      const proxies = value.split(',').map(p => p.trim()).filter(Boolean);
      for (const proxy of proxies) {
        if (!proxy.startsWith('http://') && !proxy.startsWith('https://') && !proxy.startsWith('socks://')) {
          throw new Error(`Invalid proxy URL: ${proxy}. Must start with http://, https://, or socks://`);
        }
      }
      return proxies;
    }
  },

  PROXY_HEALTH_CHECK_INTERVAL: {
    required: false,
    default: 30000,
    description: 'Proxy health check interval in milliseconds',
    validate: (value) => {
      const interval = parseInt(value, 10);
      if (isNaN(interval) || interval < 10000 || interval > 300000) {
        throw new Error('PROXY_HEALTH_CHECK_INTERVAL must be between 10000-300000ms');
      }
      return interval;
    }
  },

  // Monitoring Configuration
  METRICS_PORT: {
    required: false,
    default: 9090,
    description: 'Port for Prometheus metrics endpoint',
    validate: (value) => {
      const port = parseInt(value, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        throw new Error('METRICS_PORT must be between 1024-65535');
      }
      return port;
    }
  },

  HEALTH_CHECK_PORT: {
    required: false,
    default: 8080,
    description: 'Port for health check endpoint',
    validate: (value) => {
      const port = parseInt(value, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        throw new Error('HEALTH_CHECK_PORT must be between 1024-65535');
      }
      return port;
    }
  },

  // Existing Telegram Bot Configuration (preserved for compatibility)
  TELEGRAM_BOT_TOKEN: {
    required: false, // Only required in coordinator mode
    description: 'Telegram bot token from @BotFather',
    sensitive: true,
    validate: (value) => {
      if (value && !value.match(/^\d+:[A-Za-z0-9_-]+$/)) {
        throw new Error('TELEGRAM_BOT_TOKEN format is invalid');
      }
      return value;
    }
  },

  TARGET_LOGIN_URL: {
    required: false, // Only required in coordinator mode
    description: 'Target OAuth login URL',
    validate: (value) => {
      if (value && !value.startsWith('http')) {
        throw new Error('TARGET_LOGIN_URL must be a valid HTTP URL');
      }
      return value;
    }
  },

  FORWARD_CHANNEL_ID: {
    required: false,
    description: 'Telegram channel ID for forwarding VALID credentials',
    validate: (value) => {
      if (value && !value.match(/^-?\d+$/)) {
        throw new Error('FORWARD_CHANNEL_ID must be a numeric channel ID');
      }
      return value;
    }
  },

  ALLOWED_USER_IDS: {
    required: false,
    description: 'Comma-separated list of allowed Telegram user IDs',
    validate: (value) => {
      if (!value) return [];
      
      const userIds = value.split(',').map(id => id.trim()).filter(Boolean);
      for (const userId of userIds) {
        if (!userId.match(/^\d+$/)) {
          throw new Error(`Invalid user ID: ${userId}. Must be numeric.`);
        }
      }
      return userIds.map(id => parseInt(id, 10));
    }
  },

  // Logging Configuration
  LOG_LEVEL: {
    required: false,
    default: 'info',
    description: 'Logging level (error, warn, info, debug, trace)',
    validate: (value) => {
      const validLevels = ['error', 'warn', 'info', 'debug', 'trace'];
      const level = value.toLowerCase();
      if (!validLevels.includes(level)) {
        throw new Error(`LOG_LEVEL must be one of: ${validLevels.join(', ')}`);
      }
      return level;
    }
  },

  JSON_LOGGING: {
    required: false,
    default: false,
    description: 'Enable structured JSON logging',
    validate: (value) => {
      if (typeof value === 'string') {
        return value.toLowerCase() === 'true' || value === '1';
      }
      return Boolean(value);
    }
  },

  // Deployment Configuration
  NODE_ENV: {
    required: false,
    default: 'production',
    description: 'Node.js environment (development, production)',
    validate: (value) => {
      const validEnvs = ['development', 'production', 'test'];
      if (!validEnvs.includes(value)) {
        throw new Error(`NODE_ENV must be one of: ${validEnvs.join(', ')}`);
      }
      return value;
    }
  },

  HOSTNAME: {
    required: false,
    description: 'Hostname for worker identification',
    validate: (value) => value || require('os').hostname()
  }
};

/**
 * Validate and parse environment variables
 */
function validateEnvironment(mode = 'auto') {
  const config = {};
  const errors = [];
  const warnings = [];

  // Determine mode if auto
  if (mode === 'auto') {
    if (process.env.COORDINATOR_MODE === 'true' || process.env.COORDINATOR_MODE === '1') {
      mode = 'coordinator';
    } else if (process.env.POW_SERVICE_URL || process.env.POW_SERVICE_MODE === 'true') {
      mode = 'pow-service';
    } else {
      mode = 'worker';
    }
  }

  // Mode-specific required variables
  const modeRequirements = {
    coordinator: ['REDIS_URL', 'TELEGRAM_BOT_TOKEN', 'TARGET_LOGIN_URL'],
    worker: ['REDIS_URL'],
    'pow-service': [], // Redis is optional for POW service (runs without cache)
    single: [] // Single-node mode (existing behavior)
  };

  const requiredForMode = modeRequirements[mode] || [];

  // Validate each environment variable
  for (const [key, definition] of Object.entries(ENV_DEFINITIONS)) {
    const value = process.env[key];
    const isRequired = definition.required || requiredForMode.includes(key);

    try {
      if (value === undefined || value === '') {
        if (isRequired) {
          errors.push(`${key} is required for ${mode} mode`);
          continue;
        } else if (definition.default !== undefined) {
          config[key] = definition.validate ? definition.validate(definition.default) : definition.default;
          continue;
        } else {
          config[key] = undefined;
          continue;
        }
      }

      // Validate the value
      config[key] = definition.validate ? definition.validate(value) : value;

    } catch (error) {
      errors.push(`${key}: ${error.message}`);
    }
  }

  // Mode-specific validation
  if (mode === 'coordinator' && config.BACKUP_COORDINATOR) {
    warnings.push('Running as backup coordinator - will only activate if primary fails');
  }

  if (mode === 'worker' && !config.POW_SERVICE_URL) {
    warnings.push('POW_SERVICE_URL not set - will use local POW computation (slower)');
  }

  if (config.PROXY_POOL && config.PROXY_POOL.length === 0) {
    warnings.push('No proxies configured - will use direct connections');
  }

  // Log validation results
  if (errors.length > 0) {
    log.error('Environment validation failed', { errors, mode });
    throw new Error(`Environment validation failed:\n${errors.join('\n')}`);
  }

  if (warnings.length > 0) {
    log.warn('Environment validation warnings', { warnings, mode });
  }

  log.info('Environment validation successful', { 
    mode, 
    configuredVars: Object.keys(config).filter(k => config[k] !== undefined).length,
    totalVars: Object.keys(ENV_DEFINITIONS).length
  });

  return { config, mode, warnings };
}

/**
 * Get configuration for specific mode
 */
function getConfig(mode = 'auto') {
  const { config } = validateEnvironment(mode);
  return config;
}

/**
 * Check if running in distributed mode
 */
function isDistributedMode() {
  return Boolean(process.env.REDIS_URL);
}

/**
 * Check if running in single-node mode (existing behavior)
 */
function isSingleNodeMode() {
  return !isDistributedMode();
}

/**
 * Get deployment mode
 */
function getDeploymentMode() {
  if (process.env.COORDINATOR_MODE === 'true' || process.env.COORDINATOR_MODE === '1') {
    return 'coordinator';
  }
  if (process.env.POW_SERVICE_MODE === 'true' || process.env.POW_SERVICE_MODE === '1') {
    return 'pow-service';
  }
  if (isDistributedMode()) {
    return 'worker';
  }
  return 'single';
}

/**
 * Print configuration summary (masks sensitive values)
 */
function printConfigSummary(config) {
  const summary = {};
  
  for (const [key, value] of Object.entries(config)) {
    const definition = ENV_DEFINITIONS[key];
    if (definition && definition.sensitive) {
      summary[key] = value ? '***' : undefined;
    } else {
      summary[key] = value;
    }
  }
  
  log.info('Configuration summary', summary);
}

module.exports = {
  ENV_DEFINITIONS,
  validateEnvironment,
  getConfig,
  isDistributedMode,
  isSingleNodeMode,
  getDeploymentMode,
  printConfigSummary
};