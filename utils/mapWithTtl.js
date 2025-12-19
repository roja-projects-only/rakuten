/**
 * =============================================================================
 * MAP WITH TTL - Map wrapper with auto-expiry
 * =============================================================================
 * 
 * Provides a Map-like interface with automatic entry expiration.
 * Used for pending state management and session tracking.
 * 
 * =============================================================================
 */

/**
 * Creates a Map with automatic TTL-based expiry.
 * 
 * @param {Object} options - Configuration options
 * @param {number} [options.defaultTtlMs=300000] - Default TTL (5 minutes)
 * @param {number} [options.cleanupIntervalMs=60000] - Cleanup interval (1 minute)
 * @param {Function} [options.onExpire] - Callback when entry expires (key, value)
 * @returns {Object} Map-like object with TTL support
 */
function createMapWithTtl(options = {}) {
  const {
    defaultTtlMs = 300000, // 5 minutes
    cleanupIntervalMs = 60000, // 1 minute
    onExpire = null,
  } = options;
  
  const store = new Map(); // key -> { value, expiresAt }
  let cleanupTimer = null;
  
  /**
   * Runs cleanup to remove expired entries.
   */
  function cleanup() {
    const now = Date.now();
    const expired = [];
    
    for (const [key, entry] of store.entries()) {
      if (entry.expiresAt <= now) {
        expired.push([key, entry.value]);
      }
    }
    
    for (const [key, value] of expired) {
      store.delete(key);
      if (onExpire) {
        try {
          onExpire(key, value);
        } catch (_) {}
      }
    }
  }
  
  /**
   * Starts the cleanup timer.
   */
  function startCleanup() {
    if (!cleanupTimer && cleanupIntervalMs > 0) {
      cleanupTimer = setInterval(cleanup, cleanupIntervalMs);
      cleanupTimer.unref?.(); // Don't keep process alive
    }
  }
  
  /**
   * Stops the cleanup timer.
   */
  function stopCleanup() {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }
  
  startCleanup();
  
  return {
    /**
     * Sets a value with optional TTL.
     * @param {*} key - Key
     * @param {*} value - Value
     * @param {number} [ttlMs] - TTL in milliseconds (uses default if not provided)
     */
    set(key, value, ttlMs = defaultTtlMs) {
      store.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
      });
    },
    
    /**
     * Gets a value, returning undefined if expired.
     * @param {*} key - Key
     * @returns {*} Value or undefined
     */
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        if (onExpire) {
          try {
            onExpire(key, entry.value);
          } catch (_) {}
        }
        return undefined;
      }
      
      return entry.value;
    },
    
    /**
     * Checks if key exists and is not expired.
     * @param {*} key - Key
     * @returns {boolean}
     */
    has(key) {
      return this.get(key) !== undefined;
    },
    
    /**
     * Deletes a key.
     * @param {*} key - Key
     * @returns {boolean} True if deleted
     */
    delete(key) {
      return store.delete(key);
    },
    
    /**
     * Clears all entries.
     */
    clear() {
      store.clear();
    },
    
    /**
     * Gets current size (may include expired entries).
     * @returns {number}
     */
    get size() {
      return store.size;
    },
    
    /**
     * Iterates over non-expired entries.
     * @yields {[*, *]} Key-value pairs
     */
    *entries() {
      const now = Date.now();
      for (const [key, entry] of store.entries()) {
        if (entry.expiresAt > now) {
          yield [key, entry.value];
        }
      }
    },
    
    /**
     * Iterates over non-expired keys.
     * @yields {*} Keys
     */
    *keys() {
      for (const [key] of this.entries()) {
        yield key;
      }
    },
    
    /**
     * Iterates over non-expired values.
     * @yields {*} Values
     */
    *values() {
      for (const [, value] of this.entries()) {
        yield value;
      }
    },
    
    /**
     * Refreshes TTL for an existing key.
     * @param {*} key - Key
     * @param {number} [ttlMs] - New TTL
     * @returns {boolean} True if key exists
     */
    touch(key, ttlMs = defaultTtlMs) {
      const entry = store.get(key);
      if (entry && entry.expiresAt > Date.now()) {
        entry.expiresAt = Date.now() + ttlMs;
        return true;
      }
      return false;
    },
    
    /**
     * Gets time until expiry for a key.
     * @param {*} key - Key
     * @returns {number|null} Milliseconds until expiry, or null if not found
     */
    ttl(key) {
      const entry = store.get(key);
      if (!entry) return null;
      const remaining = entry.expiresAt - Date.now();
      return remaining > 0 ? remaining : null;
    },
    
    /**
     * Stops cleanup and clears store.
     */
    destroy() {
      stopCleanup();
      store.clear();
    },
  };
}

module.exports = { createMapWithTtl };

