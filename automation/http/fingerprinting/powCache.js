/**
 * =============================================================================
 * POW CACHE - Caches Proof-of-Work solutions for repeated mask+key+seed combos
 * =============================================================================
 * 
 * Since the same mask/key/seed often appear across multiple requests,
 * caching solutions dramatically reduces CPU load during batch processing.
 * 
 * Default TTL: 5 minutes (mdata typically refreshes every few minutes)
 * =============================================================================
 */

const { createLogger } = require('../../../logger');

const log = createLogger('pow-cache');

class PowCache {
  /**
   * @param {number} ttlMs - Time-to-live in milliseconds (default: 5 minutes)
   * @param {number} maxSize - Maximum cache entries (default: 1000)
   */
  constructor(ttlMs = 300000, maxSize = 1000) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Generate cache key from POW parameters
   * @param {Object} params - { mask, key, seed }
   * @returns {string} Cache key
   */
  key(params) {
    return `${params.mask}|${params.key}|${params.seed}`;
  }

  /**
   * Get cached POW solution
   * @param {Object} params - { mask, key, seed }
   * @returns {string|null} Cached cres or null if not found/expired
   */
  get(params) {
    const k = this.key(params);
    const entry = this.cache.get(k);
    
    if (!entry) {
      this.misses++;
      return null;
    }
    
    // Check expiration
    if (Date.now() - entry.time > this.ttlMs) {
      this.cache.delete(k);
      this.misses++;
      log.debug(`[cache] Entry expired: ${k}`);
      return null;
    }
    
    this.hits++;
    log.debug(`[cache] HIT: ${k} -> ${entry.result}`);
    return entry.result;
  }

  /**
   * Store POW solution in cache
   * @param {Object} params - { mask, key, seed }
   * @param {string} result - Computed cres
   */
  set(params, result) {
    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
      log.debug(`[cache] Evicted oldest entry: ${oldestKey}`);
    }
    
    const k = this.key(params);
    this.cache.set(k, { result, time: Date.now() });
    log.debug(`[cache] SET: ${k} -> ${result}`);
  }

  /**
   * Check if solution exists (without updating hit/miss stats)
   * @param {Object} params - { mask, key, seed }
   * @returns {boolean}
   */
  has(params) {
    const k = this.key(params);
    const entry = this.cache.get(k);
    if (!entry) return false;
    if (Date.now() - entry.time > this.ttlMs) {
      this.cache.delete(k);
      return false;
    }
    return true;
  }

  /**
   * Clear all cached entries
   */
  clear() {
    const size = this.cache.size;
    this.cache.clear();
    log.info(`[cache] Cleared ${size} entries`);
  }

  /**
   * Get cache statistics
   * @returns {Object} { size, hits, misses, hitRate }
   */
  stats() {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? ((this.hits / total) * 100).toFixed(2) + '%' : '0%'
    };
  }

  /**
   * Remove expired entries (manual cleanup)
   * @returns {number} Number of entries removed
   */
  prune() {
    const now = Date.now();
    let removed = 0;
    
    for (const [k, entry] of this.cache) {
      if (now - entry.time > this.ttlMs) {
        this.cache.delete(k);
        removed++;
      }
    }
    
    if (removed > 0) {
      log.debug(`[cache] Pruned ${removed} expired entries`);
    }
    return removed;
  }
}

// Singleton instance
const powCache = new PowCache();

module.exports = powCache;
