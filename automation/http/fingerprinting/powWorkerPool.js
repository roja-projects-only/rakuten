/**
 * =============================================================================
 * POW WORKER POOL - Multi-threaded POW computation with caching
 * =============================================================================
 * 
 * Manages a pool of worker threads for parallel POW computation.
 * Integrates with powCache to avoid redundant calculations.
 * 
 * Features:
 * - Configurable worker count (default: CPU cores - 1)
 * - Automatic task queuing when all workers busy
 * - Cache-first lookup before spawning work
 * - Graceful shutdown
 * 
 * Expected speedup: 4-8x on multi-core systems
 * =============================================================================
 */

const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');
const { createLogger } = require('../../../logger');
const powCache = require('./powCache');

const log = createLogger('pow-pool');

class PowWorkerPool {
  /**
   * @param {Object} options - Pool options
   * @param {number} [options.numWorkers] - Number of workers (default: CPU cores, min 2)
   * @param {number} [options.maxIterations] - Max POW iterations (default: 8M)
   * @param {number} [options.taskTimeout] - Task timeout in ms (default: 10s)
   */
  constructor(options = {}) {
    const cpuCount = os.cpus().length;
    // Default to all CPUs (not CPU-1) for dedicated POW service
    this.numWorkers = options.numWorkers || Math.max(2, cpuCount);
    this.maxIterations = options.maxIterations || 8000000;
    this.taskTimeout = options.taskTimeout || 30000; // 30s default
    
    this.workers = [];
    this.taskQueue = [];
    this.pendingTasks = new Map(); // id -> { resolve, reject, timeout }
    this.taskIdCounter = 0;
    this.isShutdown = false;
    this.initialized = false;
    
    // Queue management - reject early if too backed up
    this.maxQueueDepth = options.maxQueueDepth || 50;
    
    // Stats
    this.stats = {
      tasksCompleted: 0,
      tasksFailed: 0,
      tasksRejectedQueue: 0,
      cacheHits: 0,
      totalIterations: 0,
      totalTime: 0
    };
    
    log.info(`[pool] Initialized with ${this.numWorkers} workers (${cpuCount} CPUs), timeout=${this.taskTimeout}ms, maxQueue=${this.maxQueueDepth}`);
  }

  /**
   * Initialize worker threads
   */
  init() {
    if (this.initialized) return;
    
    const workerPath = path.join(__dirname, 'powWorker.js');
    
    for (let i = 0; i < this.numWorkers; i++) {
      const worker = new Worker(workerPath);
      
      worker.on('message', (msg) => this._handleWorkerMessage(worker, msg));
      worker.on('error', (err) => this._handleWorkerError(worker, err));
      worker.on('exit', (code) => this._handleWorkerExit(worker, code));
      
      worker.busy = false;
      this.workers.push(worker);
    }
    
    this.initialized = true;
    log.info(`[pool] ${this.numWorkers} workers spawned`);
  }

  /**
   * Solve POW with caching and worker pool
   * @param {Object} params - { key, seed, mask }
   * @returns {Promise<Object>} { stringToHash, iterations, executionTime, cached }
   */
  async solve(params) {
    const { key, seed, mask } = params;
    
    // Initialize workers lazily
    if (!this.initialized) {
      this.init();
    }
    
    if (this.isShutdown) {
      throw new Error('Worker pool is shutdown');
    }
    
    // Reject early if queue is too deep (prevents cascading timeouts)
    if (this.taskQueue.length >= this.maxQueueDepth) {
      this.stats.tasksRejectedQueue++;
      log.warn(`[pool] Queue full (${this.taskQueue.length}/${this.maxQueueDepth}), rejecting task`);
      const err = new Error('POW queue is full - service overloaded');
      err.code = 'POW_QUEUE_FULL';
      throw err;
    }
    
    // Check cache first
    const cached = powCache.get({ mask, key, seed });
    if (cached) {
      this.stats.cacheHits++;
      log.debug(`[pool] Cache hit for mask=${mask}`);
      return {
        stringToHash: cached,
        iterations: 0,
        executionTime: 0,
        cached: true
      };
    }
    
    // Queue task for worker
    return new Promise((resolve, reject) => {
      const id = ++this.taskIdCounter;
      
      const task = {
        id,
        key,
        seed,
        mask,
        maxIterations: this.maxIterations,
        resolve,
        reject
      };
      
      // Set timeout
      task.timeout = setTimeout(() => {
        this.pendingTasks.delete(id);
        reject(new Error(`POW task ${id} timed out after ${this.taskTimeout}ms`));
      }, this.taskTimeout);
      
      this.pendingTasks.set(id, task);
      this.taskQueue.push(task);
      
      log.debug(`[pool] Task ${id} queued (queue: ${this.taskQueue.length})`);
      
      this._dispatchNext();
    });
  }

  /**
   * Dispatch next queued task to available worker
   */
  _dispatchNext() {
    if (this.taskQueue.length === 0) return;
    
    const worker = this.workers.find(w => !w.busy);
    if (!worker) return;
    
    const task = this.taskQueue.shift();
    worker.busy = true;
    worker.currentTaskId = task.id;
    
    log.debug(`[pool] Dispatching task ${task.id} to worker`);
    
    worker.postMessage({
      id: task.id,
      key: task.key,
      seed: task.seed,
      mask: task.mask,
      maxIterations: task.maxIterations
    });
  }

  /**
   * Handle worker message (POW result)
   */
  _handleWorkerMessage(worker, msg) {
    const { id, success, result, error, iterations, executionTime } = msg;
    
    worker.busy = false;
    worker.currentTaskId = null;
    
    const task = this.pendingTasks.get(id);
    if (!task) {
      log.warn(`[pool] Received result for unknown task ${id}`);
      this._dispatchNext();
      return;
    }
    
    clearTimeout(task.timeout);
    this.pendingTasks.delete(id);
    
    if (success) {
      // Cache the result
      powCache.set({ mask: task.mask, key: task.key, seed: task.seed }, result);
      
      this.stats.tasksCompleted++;
      this.stats.totalIterations += iterations;
      this.stats.totalTime += executionTime;
      
      log.debug(`[pool] Task ${id} solved in ${iterations} iterations (${executionTime}ms)`);
      
      task.resolve({
        stringToHash: result,
        iterations,
        executionTime,
        cached: false
      });
    } else {
      this.stats.tasksFailed++;
      log.warn(`[pool] Task ${id} failed: ${error}`);
      
      const err = new Error(error);
      err.code = 'POW_FAILED';
      err.iterations = iterations;
      err.executionTime = executionTime;
      task.reject(err);
    }
    
    // Dispatch next task
    this._dispatchNext();
  }

  /**
   * Handle worker error
   */
  _handleWorkerError(worker, err) {
    log.error(`[pool] Worker error: ${err.message}`);
    
    // Reject current task if any
    if (worker.currentTaskId) {
      const task = this.pendingTasks.get(worker.currentTaskId);
      if (task) {
        clearTimeout(task.timeout);
        this.pendingTasks.delete(worker.currentTaskId);
        task.reject(new Error(`Worker error: ${err.message}`));
      }
    }
    
    worker.busy = false;
    this._dispatchNext();
  }

  /**
   * Handle worker exit
   */
  _handleWorkerExit(worker, code) {
    log.warn(`[pool] Worker exited with code ${code}`);
    
    const index = this.workers.indexOf(worker);
    if (index !== -1) {
      this.workers.splice(index, 1);
    }
    
    // Respawn worker if not shutting down
    if (!this.isShutdown && this.workers.length < this.numWorkers) {
      const workerPath = path.join(__dirname, 'powWorker.js');
      const newWorker = new Worker(workerPath);
      
      newWorker.on('message', (msg) => this._handleWorkerMessage(newWorker, msg));
      newWorker.on('error', (err) => this._handleWorkerError(newWorker, err));
      newWorker.on('exit', (code) => this._handleWorkerExit(newWorker, code));
      
      newWorker.busy = false;
      this.workers.push(newWorker);
      
      log.info(`[pool] Respawned worker (now ${this.workers.length})`);
    }
  }

  /**
   * Get pool statistics
   */
  getStats() {
    const cacheStats = powCache.stats();
    return {
      workers: {
        total: this.numWorkers,
        active: this.workers.filter(w => w.busy).length,
        alive: this.workers.length
      },
      queue: this.taskQueue.length,
      pending: this.pendingTasks.size,
      tasks: {
        completed: this.stats.tasksCompleted,
        failed: this.stats.tasksFailed,
        rejectedQueue: this.stats.tasksRejectedQueue,
        cacheHits: this.stats.cacheHits
      },
      performance: {
        avgIterations: this.stats.tasksCompleted > 0 
          ? Math.round(this.stats.totalIterations / this.stats.tasksCompleted) 
          : 0,
        avgTimeMs: this.stats.tasksCompleted > 0 
          ? Math.round(this.stats.totalTime / this.stats.tasksCompleted) 
          : 0
      },
      cache: cacheStats
    };
  }

  /**
   * Shutdown pool gracefully
   */
  async shutdown() {
    if (this.isShutdown) return;
    
    log.info('[pool] Shutting down...');
    this.isShutdown = true;
    
    // Clear task queue
    for (const task of this.taskQueue) {
      clearTimeout(task.timeout);
      task.reject(new Error('Pool shutdown'));
    }
    this.taskQueue = [];
    
    // Reject pending tasks
    for (const [id, task] of this.pendingTasks) {
      clearTimeout(task.timeout);
      task.reject(new Error('Pool shutdown'));
    }
    this.pendingTasks.clear();
    
    // Terminate workers
    await Promise.all(this.workers.map(w => w.terminate()));
    this.workers = [];
    
    log.info('[pool] Shutdown complete');
    log.info(`[pool] Final stats: ${JSON.stringify(this.getStats())}`);
  }
}

// Singleton instance
const workerPool = new PowWorkerPool();

// Graceful shutdown on process exit
process.on('SIGINT', () => workerPool.shutdown());
process.on('SIGTERM', () => workerPool.shutdown());

module.exports = workerPool;
module.exports.PowWorkerPool = PowWorkerPool;
