/**
 * Configuration Schema for Hot-Reloadable Environment Variables
 * 
 * Defines which variables can be changed at runtime via Telegram /config command,
 * with validation rules, types, and defaults.
 * 
 * Precedence: Redis > Railway/.env > Schema Default
 */

const CONFIG_SCHEMA = {
  // ═══════════════════════════════════════════════════════════════════════════
  // BATCH PROCESSING
  // ═══════════════════════════════════════════════════════════════════════════
  BATCH_CONCURRENCY: {
    type: 'int',
    default: 1,
    min: 1,
    max: 50,
    description: 'Parallel credential checks',
    category: 'batch'
  },
  BATCH_DELAY_MS: {
    type: 'int',
    default: 50,
    min: 0,
    max: 5000,
    description: 'Delay between request chunks (ms)',
    category: 'batch'
  },
  BATCH_HUMAN_DELAY_MS: {
    type: 'float',
    default: 0,
    min: 0,
    max: 1,
    description: 'Human delay multiplier (0=disabled, 0.1=10%)',
    category: 'batch'
  },
  BATCH_MAX_RETRIES: {
    type: 'int',
    default: 2,
    min: 0,
    max: 10,
    description: 'Max retry attempts per credential',
    category: 'batch'
  },
  BATCH_TIMEOUT_MS: {
    type: 'int',
    default: 120000,
    min: 30000,
    max: 600000,
    description: 'Task timeout (ms)',
    category: 'batch'
  },
  TIMEOUT_MS: {
    type: 'int',
    default: 60000,
    min: 5000,
    max: 120000,
    description: 'HTTP request timeout (ms)',
    category: 'batch'
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PROXY CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════
  PROXY_SERVER: {
    type: 'url',
    default: '',
    description: 'Single proxy URL',
    category: 'proxy',
    allowEmpty: true
  },
  PROXY_POOL: {
    type: 'csv',
    default: '',
    description: 'Comma-separated proxy URLs',
    category: 'proxy',
    allowEmpty: true
  },
  PROXY_HEALTH_CHECK_INTERVAL: {
    type: 'int',
    default: 30000,
    min: 10000,
    max: 300000,
    description: 'Proxy health check interval (ms)',
    category: 'proxy'
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // FORWARDING
  // ═══════════════════════════════════════════════════════════════════════════
  FORWARD_CHANNEL_ID: {
    type: 'string',
    default: '',
    description: 'Channel ID for VALID results',
    category: 'forward',
    allowEmpty: true,
    validate: (value) => {
      if (!value) return true;
      // Channel IDs are negative numbers or @username
      return /^-?\d+$/.test(value) || /^@[\w]+$/.test(value);
    }
  },
  FORWARD_TTL_MS: {
    type: 'int',
    default: 2592000000, // 30 days
    min: 3600000, // 1 hour
    max: 7776000000, // 90 days
    description: 'Message tracking TTL (ms)',
    category: 'forward'
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CACHE
  // ═══════════════════════════════════════════════════════════════════════════
  PROCESSED_TTL_MS: {
    type: 'int',
    default: 2592000000, // 30 days
    min: 3600000, // 1 hour
    max: 7776000000, // 90 days
    description: 'Dedupe cache TTL (ms)',
    category: 'cache'
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // WORKER SETTINGS
  // ═══════════════════════════════════════════════════════════════════════════
  WORKER_CONCURRENCY: {
    type: 'int',
    default: 3,
    min: 1,
    max: 50,
    description: 'Concurrent tasks per worker',
    category: 'worker'
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // LOGGING
  // ═══════════════════════════════════════════════════════════════════════════
  LOG_LEVEL: {
    type: 'enum',
    default: 'info',
    values: ['error', 'warn', 'info', 'debug', 'trace'],
    description: 'Logging level',
    category: 'logging'
  },
  JSON_LOGGING: {
    type: 'bool',
    default: false,
    description: 'Enable structured JSON logging',
    category: 'logging'
  }
};

/**
 * Validate a value against its schema definition
 * @param {string} key - Config key
 * @param {any} value - Value to validate
 * @returns {{ valid: boolean, error?: string, parsedValue?: any }}
 */
function validateValue(key, value) {
  const schema = CONFIG_SCHEMA[key];
  if (!schema) {
    return { valid: false, error: `Unknown config key: ${key}` };
  }

  // Handle empty values
  if (value === '' || value === null || value === undefined) {
    if (schema.allowEmpty) {
      return { valid: true, parsedValue: '' };
    }
    return { valid: false, error: `${key} cannot be empty` };
  }

  const strValue = String(value).trim();

  switch (schema.type) {
    case 'int': {
      const num = parseInt(strValue, 10);
      if (isNaN(num)) {
        return { valid: false, error: `${key} must be an integer` };
      }
      if (schema.min !== undefined && num < schema.min) {
        return { valid: false, error: `${key} must be >= ${schema.min}` };
      }
      if (schema.max !== undefined && num > schema.max) {
        return { valid: false, error: `${key} must be <= ${schema.max}` };
      }
      return { valid: true, parsedValue: num };
    }

    case 'float': {
      const num = parseFloat(strValue);
      if (isNaN(num)) {
        return { valid: false, error: `${key} must be a number` };
      }
      if (schema.min !== undefined && num < schema.min) {
        return { valid: false, error: `${key} must be >= ${schema.min}` };
      }
      if (schema.max !== undefined && num > schema.max) {
        return { valid: false, error: `${key} must be <= ${schema.max}` };
      }
      return { valid: true, parsedValue: num };
    }

    case 'bool': {
      const lower = strValue.toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(lower)) {
        return { valid: true, parsedValue: true };
      }
      if (['false', '0', 'no', 'off'].includes(lower)) {
        return { valid: true, parsedValue: false };
      }
      return { valid: false, error: `${key} must be true/false` };
    }

    case 'enum': {
      if (!schema.values.includes(strValue)) {
        return { valid: false, error: `${key} must be one of: ${schema.values.join(', ')}` };
      }
      return { valid: true, parsedValue: strValue };
    }

    case 'url': {
      if (!strValue) {
        return schema.allowEmpty 
          ? { valid: true, parsedValue: '' }
          : { valid: false, error: `${key} cannot be empty` };
      }
      if (!strValue.startsWith('http://') && !strValue.startsWith('https://') && !strValue.startsWith('socks')) {
        return { valid: false, error: `${key} must be a valid URL (http://, https://, or socks)` };
      }
      return { valid: true, parsedValue: strValue };
    }

    case 'csv': {
      // CSV is just comma-separated strings, optionally validate each as URL
      return { valid: true, parsedValue: strValue };
    }

    case 'string':
    default: {
      if (schema.validate && !schema.validate(strValue)) {
        return { valid: false, error: `${key} has invalid format` };
      }
      return { valid: true, parsedValue: strValue };
    }
  }
}

/**
 * Get the default value for a key from env or schema
 * @param {string} key - Config key
 * @returns {any} Default value
 */
function getEnvDefault(key) {
  const schema = CONFIG_SCHEMA[key];
  if (!schema) return undefined;

  // Check process.env first (Railway/.env fallback)
  const envValue = process.env[key];
  if (envValue !== undefined && envValue !== '') {
    const validation = validateValue(key, envValue);
    if (validation.valid) {
      return validation.parsedValue;
    }
  }

  return schema.default;
}

/**
 * Get all configurable keys
 * @returns {string[]}
 */
function getConfigKeys() {
  return Object.keys(CONFIG_SCHEMA);
}

/**
 * Get schema for a specific key
 * @param {string} key - Config key
 * @returns {object|undefined}
 */
function getSchema(key) {
  return CONFIG_SCHEMA[key];
}

/**
 * Get keys by category
 * @param {string} category - Category name
 * @returns {string[]}
 */
function getKeysByCategory(category) {
  return Object.entries(CONFIG_SCHEMA)
    .filter(([, schema]) => schema.category === category)
    .map(([key]) => key);
}

/**
 * Get all categories
 * @returns {string[]}
 */
function getCategories() {
  const categories = new Set(Object.values(CONFIG_SCHEMA).map(s => s.category));
  return Array.from(categories);
}

module.exports = {
  CONFIG_SCHEMA,
  validateValue,
  getEnvDefault,
  getConfigKeys,
  getSchema,
  getKeysByCategory,
  getCategories
};
