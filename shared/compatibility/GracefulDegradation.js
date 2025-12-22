/**
 * Graceful Degradation Handler
 * 
 * Handles service unavailability scenarios with automatic fallbacks:
 * - Redis unavailable: fall back to in-memory
 * - POW service unavailable: use local computation
 * - Telegram API unavailable: retry with backoff
 * 
 * Requirements: 9.4, 3.7
 */

const { createLogger } = require('../../logger');
const { SingleNodeMode } = require('./SingleNodeMode');

const log = createLogger('graceful-degradation');

class GracefulDegradation {
  constructor() {
    this.degradationState = {
      redis: { available: true, lastCheck: 0, fallbackActive: false },
      powService: { available: true, lastCheck: 0, fallbackActive: false },
      telegram: { available: true, lastCheck: 0, retryCount: 0 }
    };
    
    this.checkInterval = 30000; // Check service health every 30 seconds
    this.retryBackoff = [1000, 2000, 5000, 10000, 30000]; // Exponential backoff
  }

  /**
   * Check Redis availability and handle fallback
   * @param {Function} redisOperation - Redis operation to test
   * @returns {Promise<{available: boolean, fallback: boolean}>}
   */
  async checkRedisAvailability(redisOperation) {
    const now = Date.now();
    const state = this.degradationState.redis;
    
    // Skip check if recently verified
    if (state.available && (now - state.lastCheck) < this.checkInterval) {
      return { available: true, fallback: false };
    }
    
    try {
      // Test Redis with a simple operation
      if (redisOperation) {
        await redisOperation();
      }
      
      // Redis is available
      if (state.fallbackActive) {
        log.info('Redis service restored - switching back from fallback mode');
        state.fallbackActive = false;
      }
      
      state.available = true;
      state.lastCheck = now;
      
      return { available: true, fallback: false };
      
    } catch (error) {
      log.warn('Redis unavailable, activating fallback mode', {
        error: error.message
      });
      
      if (!state.fallbackActive) {
        log.warn('Degradation: Redis → In-memory storage');
        log.warn('  - Job queue: In-memory queue');
        log.warn('  - Results: JSONL file storage');
        log.warn('  - Progress: Local tracking');
        state.fallbackActive = true;
      }
      
      state.available = false;
      state.lastCheck = now;
      
      return { available: false, fallback: true };
    }
  }

  /**
   * Check POW service availability and handle fallback
   * @param {string} powServiceUrl - POW service URL
   * @returns {Promise<{available: boolean, fallback: boolean}>}
   */
  async checkPowServiceAvailability(powServiceUrl) {
    const now = Date.now();
    const state = this.degradationState.powService;
    
    // Skip check if recently verified or no POW service configured
    if (!powServiceUrl) {
      return { available: false, fallback: true };
    }
    
    if (state.available && (now - state.lastCheck) < this.checkInterval) {
      return { available: true, fallback: false };
    }
    
    try {
      // Test POW service health endpoint
      const fetch = require('node-fetch');
      const response = await fetch(`${powServiceUrl}/health`, {
        timeout: 5000,
        method: 'GET'
      });
      
      if (!response.ok) {
        throw new Error(`POW service health check failed: ${response.status}`);
      }
      
      // POW service is available
      if (state.fallbackActive) {
        log.info('POW service restored - switching back from local computation');
        state.fallbackActive = false;
      }
      
      state.available = true;
      state.lastCheck = now;
      
      return { available: true, fallback: false };
      
    } catch (error) {
      log.warn('POW service unavailable, using local computation', {
        powServiceUrl,
        error: error.message
      });
      
      if (!state.fallbackActive) {
        log.warn('Degradation: POW Service → Local computation');
        log.warn('  - Performance: Slower credential checking');
        log.warn('  - CPU usage: Higher on worker nodes');
        log.warn('  - Caching: Local memory only');
        state.fallbackActive = true;
      }
      
      state.available = false;
      state.lastCheck = now;
      
      return { available: false, fallback: true };
    }
  }

  /**
   * Handle Telegram API unavailability with retry and backoff
   * @param {Function} telegramOperation - Telegram operation to retry
   * @param {Object} options - Retry options
   * @returns {Promise<any>} Operation result
   */
  async handleTelegramWithRetry(telegramOperation, options = {}) {
    const maxRetries = options.maxRetries || 5;
    const state = this.degradationState.telegram;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await telegramOperation();
        
        // Success - reset retry count and mark as available
        if (state.retryCount > 0) {
          log.info('Telegram API restored after retries', {
            previousRetries: state.retryCount
          });
        }
        
        state.available = true;
        state.retryCount = 0;
        state.lastCheck = Date.now();
        
        return result;
        
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;
        
        // Check if this is a retryable error
        if (!this.isTelegramRetryableError(error) || isLastAttempt) {
          log.error('Telegram API operation failed permanently', {
            attempt: attempt + 1,
            maxRetries: maxRetries + 1,
            error: error.message,
            retryable: this.isTelegramRetryableError(error)
          });
          
          state.available = false;
          state.retryCount = attempt + 1;
          
          throw error;
        }
        
        // Calculate backoff delay
        const backoffIndex = Math.min(attempt, this.retryBackoff.length - 1);
        const delay = this.retryBackoff[backoffIndex];
        
        log.warn('Telegram API operation failed, retrying with backoff', {
          attempt: attempt + 1,
          maxRetries: maxRetries + 1,
          delay,
          error: error.message
        });
        
        if (!state.available) {
          log.warn('Degradation: Telegram API → Retry with exponential backoff');
          log.warn(`  - Delay: ${delay}ms`);
          log.warn('  - Messages may be delayed');
        }
        
        state.available = false;
        state.retryCount = attempt + 1;
        
        // Wait before retry
        await this.sleep(delay);
      }
    }
  }

  /**
   * Check if Telegram error is retryable
   * @param {Error} error - Error to check
   * @returns {boolean} True if retryable
   */
  isTelegramRetryableError(error) {
    const message = error.message.toLowerCase();
    
    // Network errors are retryable
    if (message.includes('network') || 
        message.includes('timeout') || 
        message.includes('econnreset') ||
        message.includes('enotfound') ||
        message.includes('econnrefused')) {
      return true;
    }
    
    // Telegram rate limiting is retryable
    if (message.includes('too many requests') || 
        message.includes('rate limit') ||
        message.includes('429')) {
      return true;
    }
    
    // Server errors are retryable
    if (message.includes('500') || 
        message.includes('502') || 
        message.includes('503') || 
        message.includes('504')) {
      return true;
    }
    
    // Client errors (4xx except 429) are not retryable
    return false;
  }

  /**
   * Create a Redis client wrapper with fallback
   * @param {Object} redisClient - Original Redis client
   * @returns {Object} Wrapped client with fallback
   */
  createRedisWrapper(redisClient) {
    const self = this;
    
    return {
      async executeCommand(command, ...args) {
        const { available, fallback } = await self.checkRedisAvailability(
          () => redisClient.executeCommand('ping')
        );
        
        if (available) {
          return await redisClient.executeCommand(command, ...args);
        } else {
          // Fallback to single-node mode
          throw new Error('Redis unavailable - use single-node mode');
        }
      },
      
      async isHealthy() {
        const { available } = await self.checkRedisAvailability();
        return available;
      },
      
      getClient() {
        return redisClient.getClient();
      },
      
      async close() {
        return await redisClient.close();
      }
    };
  }

  /**
   * Create a POW service client wrapper with fallback
   * @param {Object} powClient - Original POW client
   * @returns {Object} Wrapped client with fallback
   */
  createPowServiceWrapper(powClient) {
    const self = this;
    
    return {
      async computeCres(mdata, options = {}) {
        const { available, fallback } = await self.checkPowServiceAvailability(
          options.powServiceUrl || process.env.POW_SERVICE_URL
        );
        
        if (available) {
          try {
            return await powClient.computeCres(mdata, options);
          } catch (error) {
            log.warn('POW service request failed, falling back to local computation', {
              error: error.message
            });
            
            // Mark as unavailable and fall through to local computation
            self.degradationState.powService.available = false;
            self.degradationState.powService.fallbackActive = true;
          }
        }
        
        // Fallback to local computation
        log.debug('Using local POW computation fallback');
        
        // Use existing local POW computation
        const { computeCresFromMdata } = require('../../automation/http/fingerprinting/challengeGenerator');
        return await computeCresFromMdata(mdata);
      }
    };
  }

  /**
   * Create a Telegram client wrapper with retry
   * @param {Object} telegram - Telegram bot instance
   * @returns {Object} Wrapped client with retry
   */
  createTelegramWrapper(telegram) {
    const self = this;
    
    return {
      async sendMessage(chatId, text, options = {}) {
        return await self.handleTelegramWithRetry(
          () => telegram.sendMessage(chatId, text, options),
          { maxRetries: 3 }
        );
      },
      
      async editMessageText(chatId, messageId, inlineMessageId, text, options = {}) {
        return await self.handleTelegramWithRetry(
          () => telegram.editMessageText(chatId, messageId, inlineMessageId, text, options),
          { maxRetries: 3 }
        );
      },
      
      async deleteMessage(chatId, messageId) {
        return await self.handleTelegramWithRetry(
          () => telegram.deleteMessage(chatId, messageId),
          { maxRetries: 2 }
        );
      },
      
      async sendDocument(chatId, document, options = {}) {
        return await self.handleTelegramWithRetry(
          () => telegram.sendDocument(chatId, document, options),
          { maxRetries: 2 }
        );
      },
      
      // Pass through other methods
      ...telegram
    };
  }

  /**
   * Get degradation status summary
   * @returns {Object} Status of all services
   */
  getDegradationStatus() {
    return {
      redis: {
        available: this.degradationState.redis.available,
        fallbackActive: this.degradationState.redis.fallbackActive,
        lastCheck: this.degradationState.redis.lastCheck
      },
      powService: {
        available: this.degradationState.powService.available,
        fallbackActive: this.degradationState.powService.fallbackActive,
        lastCheck: this.degradationState.powService.lastCheck
      },
      telegram: {
        available: this.degradationState.telegram.available,
        retryCount: this.degradationState.telegram.retryCount,
        lastCheck: this.degradationState.telegram.lastCheck
      }
    };
  }

  /**
   * Log degradation warnings for all active fallbacks
   */
  logDegradationWarnings() {
    const status = this.getDegradationStatus();
    const warnings = [];
    
    if (status.redis.fallbackActive) {
      warnings.push('Redis unavailable - using in-memory storage');
    }
    
    if (status.powService.fallbackActive) {
      warnings.push('POW service unavailable - using local computation (slower)');
    }
    
    if (!status.telegram.available) {
      warnings.push(`Telegram API issues - ${status.telegram.retryCount} retries`);
    }
    
    if (warnings.length > 0) {
      log.warn('Active service degradations:', warnings);
    }
  }

  /**
   * Sleep utility
   * @param {number} ms - Milliseconds to sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Start periodic degradation monitoring
   */
  startMonitoring() {
    setInterval(() => {
      this.logDegradationWarnings();
    }, 60000); // Log warnings every minute
    
    log.info('Graceful degradation monitoring started');
  }

  /**
   * Create a complete compatibility layer for distributed components
   * @param {Object} options - Configuration options
   * @returns {Object} Wrapped components with fallback
   */
  static createCompatibilityLayer(options = {}) {
    const degradation = new GracefulDegradation();
    
    // Start monitoring
    degradation.startMonitoring();
    
    // Check if Redis is available
    const redisAvailable = Boolean(process.env.REDIS_URL);
    
    if (!redisAvailable) {
      log.warn('Redis not configured - using single-node mode with graceful degradation');
      
      // Return single-node mode with degradation wrappers
      const singleNode = SingleNodeMode.createCompatibilityWrapper();
      
      return {
        ...singleNode,
        degradation,
        
        // Wrap Telegram with retry logic
        wrapTelegram: (telegram) => degradation.createTelegramWrapper(telegram),
        
        // Wrap POW service with fallback
        wrapPowService: (powClient) => degradation.createPowServiceWrapper(powClient)
      };
    }
    
    return {
      degradation,
      
      // Wrap Redis with fallback detection
      wrapRedis: (redisClient) => degradation.createRedisWrapper(redisClient),
      
      // Wrap Telegram with retry logic
      wrapTelegram: (telegram) => degradation.createTelegramWrapper(telegram),
      
      // Wrap POW service with fallback
      wrapPowService: (powClient) => degradation.createPowServiceWrapper(powClient)
    };
  }
}

module.exports = {
  GracefulDegradation
};