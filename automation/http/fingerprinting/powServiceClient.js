/**
 * =============================================================================
 * POW SERVICE CLIENT - HTTP client for POW microservice with fallback
 * =============================================================================
 * 
 * HTTP client for communicating with the POW service with timeout and fallback.
 * Features:
 * - 5-second timeout for HTTP requests
 * - Fallback to local POW computation on timeout/error
 * - Local memory cache for fallback results (not Redis)
 * - Automatic retry logic with exponential backoff
 * 
 * Requirements: 3.1, 3.5, 3.6, 3.7
 * =============================================================================
 */

const axios = require('axios');
const { createLogger } = require('../../../logger');
const { solvePow, generateRandomCres } = require('./challengeGenerator');

const log = createLogger('pow-client');

class POWServiceClient {
  constructor(options = {}) {
    this.serviceUrl = options.serviceUrl || process.env.POW_SERVICE_URL || 'http://localhost:3001';
    this.timeout = options.timeout || parseInt(process.env.POW_CLIENT_TIMEOUT, 10) || 25000; // 25s (service has 30s)
    this.maxRetries = options.maxRetries || 1; // Reduced retries - fallback faster
    this.retryDelay = options.retryDelay || 500; // 500ms base delay
    
    // Local memory cache for fallback results (not Redis)
    this.localCache = new Map();
    this.maxCacheSize = options.maxCacheSize || 1000;
    this.cacheTTL = options.cacheTTL || 300000; // 5 minutes in ms
    
    // Statistics
    this.stats = {
      requestsTotal: 0,
      requestsSuccess: 0,
      requestsTimeout: 0,
      requestsError: 0,
      fallbacksTotal: 0,
      localCacheHits: 0,
      localCacheMisses: 0
    };
    
    // Create axios instance with default config
    // IMPORTANT: Disable proxy for internal service calls
    this.httpClient = axios.create({
      baseURL: this.serviceUrl,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'POW-Client/1.0.0'
      },
      // Explicitly disable proxy for internal service communication
      proxy: false,
      // Ensure no proxy agents are used
      httpsAgent: undefined,
      httpAgent: undefined
    });
    
    log.info('POW service client initialized', { 
      serviceUrl: this.serviceUrl, 
      timeout: this.timeout 
    });
  }

  /**
   * Compute cres using POW service with fallback to local computation
   * @param {Object} params - POW parameters
   * @param {string} params.mask - Mask from mdata (hex prefix to match)
   * @param {string} params.key - Key from mdata (hex string)
   * @param {number} params.seed - Seed from mdata (integer)
   * @returns {Promise<string>} The computed cres value
   */
  async computeCres(params) {
    const { mask, key, seed } = params;
    
    // Validate input parameters
    if (!mask || !key || seed === undefined) {
      log.warn('Invalid POW parameters, using random cres', { mask, key, seed });
      return generateRandomCres();
    }
    
    this.stats.requestsTotal++;
    
    // Check local cache first (for fallback results)
    const cacheKey = `${mask}:${key}:${seed}`;
    const cached = this.getFromLocalCache(cacheKey);
    if (cached) {
      this.stats.localCacheHits++;
      log.debug('Local cache hit', { cacheKey, cres: cached });
      return cached;
    }
    
    this.stats.localCacheMisses++;
    
    try {
      // Try POW service first
      const result = await this.requestFromService(params);
      this.stats.requestsSuccess++;
      
      log.debug('POW service success', { 
        mask, 
        key, 
        seed, 
        cres: result.cres,
        cached: result.cached,
        computeTimeMs: result.computeTimeMs 
      });
      
      return result.cres;
      
    } catch (error) {
      // Log the service failure
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        log.warn('POW service unavailable, falling back to local computation', { 
          serviceUrl: this.serviceUrl,
          error: error.message 
        });
      } else if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        this.stats.requestsTimeout++;
        log.warn('POW service timeout, falling back to local computation', { 
          timeout: this.timeout,
          mask, key, seed 
        });
      } else {
        this.stats.requestsError++;
        log.warn('POW service error, falling back to local computation', { 
          error: error.message,
          mask, key, seed 
        });
      }
      
      // Fallback to local computation
      return await this.fallbackToLocal(params, cacheKey);
    }
  }

  /**
   * Request cres from POW service with retry logic
   * @param {Object} params - POW parameters
   * @returns {Promise<Object>} Service response
   */
  async requestFromService(params, retryCount = 0) {
    try {
      const response = await this.httpClient.post('/compute', params);
      
      if (response.status !== 200) {
        throw new Error(`POW service returned status ${response.status}`);
      }
      
      if (!response.data || !response.data.cres) {
        throw new Error('POW service returned invalid response');
      }
      
      return response.data;
      
    } catch (error) {
      // If this is a retryable error and we haven't exceeded max retries
      if (retryCount < this.maxRetries && this.isRetryableError(error)) {
        const delay = this.retryDelay * Math.pow(2, retryCount); // Exponential backoff
        log.debug('Retrying POW service request', { 
          retryCount: retryCount + 1, 
          maxRetries: this.maxRetries,
          delay 
        });
        
        await this.sleep(delay);
        return await this.requestFromService(params, retryCount + 1);
      }
      
      // Re-throw the error for fallback handling
      throw error;
    }
  }

  /**
   * Fallback to local POW computation and cache result
   * @param {Object} params - POW parameters
   * @param {string} cacheKey - Cache key for storing result
   * @returns {Promise<string>} Computed cres
   */
  async fallbackToLocal(params, cacheKey) {
    this.stats.fallbacksTotal++;
    
    try {
      log.debug('Computing POW locally', params);
      
      const result = solvePow(params);
      const cres = result.stringToHash;
      
      // Cache the result in local memory only (not Redis)
      this.setInLocalCache(cacheKey, cres);
      
      log.info('Local POW computation successful', {
        mask: params.mask,
        key: params.key,
        seed: params.seed,
        cres,
        iterations: result.iterations,
        executionTime: result.executionTime
      });
      
      return cres;
      
    } catch (error) {
      log.error('Local POW computation failed', { 
        error: error.message,
        params 
      });
      
      // Last resort: return random cres
      const randomCres = generateRandomCres();
      log.warn('Using random cres as last resort', { randomCres });
      return randomCres;
    }
  }

  /**
   * Check if error is retryable
   * @param {Error} error - Error to check
   * @returns {boolean} True if retryable
   */
  isRetryableError(error) {
    // Retry on network errors, timeouts, and 5xx server errors
    return (
      error.code === 'ECONNRESET' ||
      error.code === 'ECONNABORTED' ||
      error.code === 'ETIMEDOUT' ||
      error.message.includes('timeout') ||
      (error.response && error.response.status >= 500)
    );
  }

  /**
   * Get value from local cache
   * @param {string} key - Cache key
   * @returns {string|null} Cached value or null
   */
  getFromLocalCache(key) {
    const entry = this.localCache.get(key);
    if (!entry) {
      return null;
    }
    
    // Check if entry has expired
    if (Date.now() > entry.expiresAt) {
      this.localCache.delete(key);
      return null;
    }
    
    return entry.value;
  }

  /**
   * Set value in local cache with TTL
   * @param {string} key - Cache key
   * @param {string} value - Value to cache
   */
  setInLocalCache(key, value) {
    // Implement simple LRU eviction if cache is full
    if (this.localCache.size >= this.maxCacheSize) {
      const firstKey = this.localCache.keys().next().value;
      this.localCache.delete(firstKey);
    }
    
    this.localCache.set(key, {
      value,
      expiresAt: Date.now() + this.cacheTTL
    });
  }

  /**
   * Clear expired entries from local cache
   */
  cleanupLocalCache() {
    const now = Date.now();
    for (const [key, entry] of this.localCache.entries()) {
      if (now > entry.expiresAt) {
        this.localCache.delete(key);
      }
    }
  }

  /**
   * Get client statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    return {
      service: {
        url: this.serviceUrl,
        timeout: this.timeout
      },
      requests: {
        total: this.stats.requestsTotal,
        success: this.stats.requestsSuccess,
        timeout: this.stats.requestsTimeout,
        error: this.stats.requestsError,
        successRate: this.stats.requestsTotal > 0 ? 
          ((this.stats.requestsSuccess / this.stats.requestsTotal) * 100).toFixed(2) + '%' : '0%'
      },
      fallback: {
        total: this.stats.fallbacksTotal,
        rate: this.stats.requestsTotal > 0 ? 
          ((this.stats.fallbacksTotal / this.stats.requestsTotal) * 100).toFixed(2) + '%' : '0%'
      },
      localCache: {
        size: this.localCache.size,
        maxSize: this.maxCacheSize,
        hits: this.stats.localCacheHits,
        misses: this.stats.localCacheMisses,
        hitRate: (this.stats.localCacheHits + this.stats.localCacheMisses) > 0 ?
          ((this.stats.localCacheHits / (this.stats.localCacheHits + this.stats.localCacheMisses)) * 100).toFixed(2) + '%' : '0%'
      }
    };
  }

  /**
   * Test connection to POW service
   * @returns {Promise<boolean>} True if service is available
   */
  async testConnection() {
    try {
      const response = await this.httpClient.get('/health', { timeout: 2000 });
      return response.status === 200;
    } catch (error) {
      log.debug('POW service connection test failed', { error: error.message });
      return false;
    }
  }

  /**
   * Sleep utility for retry delays
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Start periodic cache cleanup
   */
  startCacheCleanup() {
    // Clean up expired cache entries every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupLocalCache();
    }, 300000);
  }

  /**
   * Stop periodic cache cleanup
   */
  stopCacheCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Shutdown the client gracefully
   */
  shutdown() {
    this.stopCacheCleanup();
    this.localCache.clear();
    log.info('POW service client shutdown complete');
  }
}

// Create singleton instance
const powServiceClient = new POWServiceClient();

// Start cache cleanup
powServiceClient.startCacheCleanup();

// Graceful shutdown on process exit
process.on('SIGINT', () => powServiceClient.shutdown());
process.on('SIGTERM', () => powServiceClient.shutdown());

module.exports = powServiceClient;
module.exports.POWServiceClient = POWServiceClient;