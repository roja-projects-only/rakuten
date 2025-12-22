/**
 * Proxy Pool Manager - Coordinator Component
 * 
 * Manages residential proxy rotation with health tracking and sticky assignment.
 * Implements round-robin proxy assignment with health filtering.
 * 
 * Requirements: 4.1, 4.2, 4.4, 4.5, 4.6, 4.7
 */

const { createLogger } = require('../../logger');
const { createStructuredLogger } = require('../logger/structured');
const { PROXY_HEALTH } = require('../redis/keys');

const log = createLogger('proxy-pool-manager');
const structuredLog = createStructuredLogger('proxy-pool-manager');

class ProxyPoolManager {
  constructor(redisClient, proxies = []) {
    this.redis = redisClient;
    this.proxies = this._loadProxiesFromConfig(proxies);
    this.roundRobinIndex = 0;
    
    log.info(`ProxyPoolManager initialized with ${this.proxies.length} proxies`);
  }

  /**
   * Load proxies from environment variable or provided array
   * @param {Array<string>} proxies - Array of proxy URLs or empty to load from env
   * @returns {Array<string>} Array of proxy URLs
   */
  _loadProxiesFromConfig(proxies) {
    // If proxies provided directly, use them
    if (proxies && proxies.length > 0) {
      return proxies;
    }

    // Load from environment variable (comma-separated)
    const proxyEnv = process.env.PROXY_SERVERS || process.env.PROXY_SERVER;
    if (!proxyEnv) {
      log.warn('No proxies configured - workers will use direct connections');
      return [];
    }

    const proxyList = proxyEnv.split(',').map(proxy => proxy.trim()).filter(Boolean);
    log.info(`Loaded ${proxyList.length} proxies from environment`);
    return proxyList;
  }

  /**
   * Generate proxy ID from index
   * @param {number} index - Proxy index
   * @returns {string} Proxy ID (e.g., "p001")
   */
  _generateProxyId(index) {
    return `p${String(index + 1).padStart(3, '0')}`;
  }

  /**
   * Check if a proxy is healthy by querying Redis health state
   * @param {string} proxyId - Proxy identifier
   * @returns {Promise<boolean>} True if proxy is healthy
   */
  async _isProxyHealthy(proxyId) {
    try {
      const healthKey = PROXY_HEALTH.generate(proxyId);
      const healthData = await this.redis.executeCommand('get', healthKey);
      
      if (!healthData) {
        // No health data means proxy hasn't been tested yet - assume healthy
        return true;
      }

      const health = JSON.parse(healthData);
      return health.healthy !== false;
    } catch (error) {
      log.error(`Error checking proxy health for ${proxyId}`, { error: error.message });
      // On error, assume healthy to avoid blocking all proxies
      return true;
    }
  }

  /**
   * Get list of healthy proxy indices
   * @returns {Promise<Array<number>>} Array of healthy proxy indices
   */
  async _getHealthyProxyIndices() {
    const healthyIndices = [];
    
    for (let i = 0; i < this.proxies.length; i++) {
      const proxyId = this._generateProxyId(i);
      const isHealthy = await this._isProxyHealthy(proxyId);
      
      if (isHealthy) {
        healthyIndices.push(i);
      }
    }
    
    return healthyIndices;
  }

  /**
   * Assign a proxy to a task using round-robin with health filtering
   * @param {string} taskId - Task identifier for logging
   * @returns {Promise<{proxyId, proxyUrl}|null>}
   */
  async assignProxy(taskId) {
    // Return null if no proxies configured (fallback to direct connection)
    if (this.proxies.length === 0) {
      log.debug(`No proxies configured for task ${taskId} - using direct connection`);
      return null;
    }

    // Get list of healthy proxies
    const healthyIndices = await this._getHealthyProxyIndices();
    
    // If all proxies are unhealthy, return null (fallback to direct connection)
    if (healthyIndices.length === 0) {
      log.warn(`All proxies are unhealthy for task ${taskId} - using direct connection`);
      return null;
    }

    // Select next healthy proxy using round-robin
    const healthyIndex = this.roundRobinIndex % healthyIndices.length;
    const proxyIndex = healthyIndices[healthyIndex];
    const proxyUrl = this.proxies[proxyIndex];
    const proxyId = this._generateProxyId(proxyIndex);
    
    // Increment round-robin index (wrap around)
    this.roundRobinIndex++;
    
    log.debug(`Assigned proxy ${proxyId} to task ${taskId}`, {
      taskId,
      proxyId,
      proxyUrl,
      healthyProxies: healthyIndices.length,
      totalProxies: this.proxies.length
    });

    return {
      proxyId,
      proxyUrl
    };
  }

  /**
   * Record proxy success or failure
   * @param {string} proxyId - Proxy identifier
   * @param {boolean} success - True if request succeeded
   */
  async recordProxyResult(proxyId, success) {
    try {
      const healthKey = PROXY_HEALTH.generate(proxyId);
      
      // Get current health state
      let healthData = await this.redis.executeCommand('get', healthKey);
      let health;
      
      if (!healthData) {
        // Initialize health state for new proxy
        health = {
          proxyId,
          consecutiveFailures: 0,
          totalRequests: 0,
          successCount: 0,
          successRate: 0,
          lastSuccess: null,
          lastFailure: null,
          healthy: true
        };
      } else {
        health = JSON.parse(healthData);
      }
      
      // Update statistics
      health.totalRequests++;
      const now = Date.now();
      
      if (success) {
        // Reset consecutive failures on success
        health.consecutiveFailures = 0;
        health.successCount++;
        health.lastSuccess = now;
        
        // If was unhealthy, restore to active rotation
        if (health.healthy === false) {
          log.info(`Proxy ${proxyId} restored to active rotation after success`);
          health.healthy = true;
          
          // Log structured proxy health change
          structuredLog.logProxyHealth({
            proxyId,
            proxyUrl: this.proxies[parseInt(proxyId.substring(1)) - 1],
            healthy: true,
            consecutiveFailures: health.consecutiveFailures,
            successRate: health.successRate,
            lastSuccess: health.lastSuccess,
            lastFailure: health.lastFailure
          });
        }
      } else {
        // Increment consecutive failures
        health.consecutiveFailures++;
        health.lastFailure = now;
        
        // Mark unhealthy after 3 consecutive failures
        if (health.consecutiveFailures >= 3 && health.healthy !== false) {
          log.warn(`Proxy ${proxyId} marked unhealthy after ${health.consecutiveFailures} consecutive failures`);
          health.healthy = false;
          
          // Log structured proxy health change
          structuredLog.logProxyHealth({
            proxyId,
            proxyUrl: this.proxies[parseInt(proxyId.substring(1)) - 1],
            healthy: false,
            consecutiveFailures: health.consecutiveFailures,
            successRate: health.successRate,
            lastSuccess: health.lastSuccess,
            lastFailure: health.lastFailure
          });
        }
      }
      
      // Calculate success rate
      health.successRate = health.totalRequests > 0 ? health.successCount / health.totalRequests : 0;
      
      // Store updated health state in Redis
      if (health.healthy === false) {
        // Set TTL for unhealthy proxies (5 minutes)
        await this.redis.executeCommand('setex', healthKey, PROXY_HEALTH.ttl, JSON.stringify(health));
        log.debug(`Proxy ${proxyId} health updated (unhealthy, TTL: ${PROXY_HEALTH.ttl}s)`, {
          proxyId,
          consecutiveFailures: health.consecutiveFailures,
          successRate: health.successRate.toFixed(3),
          totalRequests: health.totalRequests
        });
      } else {
        // No TTL for healthy proxies (persist indefinitely)
        await this.redis.executeCommand('set', healthKey, JSON.stringify(health));
        log.debug(`Proxy ${proxyId} health updated (healthy)`, {
          proxyId,
          consecutiveFailures: health.consecutiveFailures,
          successRate: health.successRate.toFixed(3),
          totalRequests: health.totalRequests
        });
      }
      
    } catch (error) {
      log.error(`Error recording proxy result for ${proxyId}`, { 
        error: error.message,
        proxyId,
        success
      });
    }
  }

  /**
   * Get proxy health statistics
   * @returns {Promise<Array<{proxyId, proxyUrl, healthy, successRate, totalRequests, consecutiveFailures, lastSuccess, lastFailure}>>}
   */
  async getProxyStats() {
    const stats = [];
    
    for (let i = 0; i < this.proxies.length; i++) {
      const proxyId = this._generateProxyId(i);
      const proxyUrl = this.proxies[i];
      
      try {
        const healthKey = PROXY_HEALTH.generate(proxyId);
        const healthData = await this.redis.executeCommand('get', healthKey);
        
        if (!healthData) {
          // No health data - proxy hasn't been tested yet
          stats.push({
            proxyId,
            proxyUrl,
            healthy: true,
            successRate: null,
            totalRequests: 0,
            consecutiveFailures: 0,
            lastSuccess: null,
            lastFailure: null
          });
        } else {
          const health = JSON.parse(healthData);
          stats.push({
            proxyId: health.proxyId,
            proxyUrl,
            healthy: health.healthy !== false,
            successRate: health.successRate,
            totalRequests: health.totalRequests,
            consecutiveFailures: health.consecutiveFailures,
            lastSuccess: health.lastSuccess,
            lastFailure: health.lastFailure
          });
        }
      } catch (error) {
        log.error(`Error getting stats for proxy ${proxyId}`, { error: error.message });
        // Return error state
        stats.push({
          proxyId,
          proxyUrl,
          healthy: false,
          successRate: null,
          totalRequests: 0,
          consecutiveFailures: 999,
          lastSuccess: null,
          lastFailure: Date.now(),
          error: error.message
        });
      }
    }
    
    return stats;
  }
}

module.exports = ProxyPoolManager;