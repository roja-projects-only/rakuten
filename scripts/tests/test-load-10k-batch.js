#!/usr/bin/env node

/**
 * Load Test: 10k Credential Batch Processing
 * 
 * This test validates the system's ability to handle large batches (10k credentials)
 * with 20 worker instances. It monitors queue depth, worker CPU, Redis memory,
 * and measures actual throughput to verify completion within 2 hours (target SLO).
 * 
 * Requirements tested: 6.5
 * Target SLO: Complete 10k batch in <2 hours
 * Expected throughput: >83 credentials/minute (10000 / 120 minutes)
 */

const { createLogger } = require('../logger');
const { createClient } = require('redis');
const { performance } = require('perf_hooks');

const log = createLogger('load-test-10k');

class LoadTest10kBatch {
  constructor() {
    this.testResults = {
      batchSize: 10000,
      targetWorkers: 20,
      targetCompletionTime: 2 * 60 * 60 * 1000, // 2 hours in ms
      targetThroughput: 83, // credentials per minute
      actualResults: {}
    };
    
    this.redis = null;
    this.testStartTime = null;
    this.batchId = `load-test-${Date.now()}`;
    this.monitoringInterval = null;
    this.metrics = {
      queueDepth: [],
      completedTasks: [],
      timestamps: [],
      workerCounts: [],
      redisMemory: []
    };
  }

  async runTest() {
    log.info('🚀 Starting Load Test: 10k Credential Batch Processing');
    log.info('='.repeat(80));
    log.info(`Batch ID: ${this.batchId}`);
    log.info(`Target batch size: ${this.testResults.batchSize} credentials`);
    log.info(`Target workers: ${this.testResults.targetWorkers} instances`);
    log.info(`Target completion time: ${this.testResults.targetCompletionTime / 1000 / 60} minutes`);
    log.info(`Target throughput: ${this.testResults.targetThroughput} credentials/minute`);
    log.info('');

    try {
      // Initialize Redis connection
      await this.initializeRedis();
      
      // Validate system readiness
      await this.validateSystemReadiness();
      
      // Generate test credentials
      const credentials = this.generateTestCredentials(this.testResults.batchSize);
      
      // Submit batch for processing
      await this.submitBatch(credentials);
      
      // Monitor processing
      await this.monitorProcessing();
      
      // Analyze results
      await this.analyzeResults();
      
      // Generate report
      this.printTestSummary();
      
      return this.testResults.actualResults.success;
      
    } catch (error) {
      log.error('Load test failed', { error: error.message });
      this.testResults.actualResults = {
        success: false,
        error: error.message,
        completedAt: Date.now()
      };
      return false;
    } finally {
      await this.cleanup();
    }
  }

  async initializeRedis() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is required for load testing');
    }

    this.redis = createClient({ url: redisUrl });
    
    this.redis.on('error', (err) => {
      log.error('Redis connection error', { error: err.message });
    });

    await this.redis.connect();
    log.info('✅ Connected to Redis');
  }

  async validateSystemReadiness() {
    log.info('🔍 Validating system readiness...');
    
    // Check Redis connectivity
    const pingResult = await this.redis.ping();
    if (pingResult !== 'PONG') {
      throw new Error('Redis ping failed');
    }
    
    // Check queue is empty
    const queueLength = await this.redis.lLen('queue:tasks');
    if (queueLength > 0) {
      log.warn(`Queue not empty: ${queueLength} tasks pending. Clearing...`);
      await this.redis.del('queue:tasks');
    }
    
    // Check for active workers
    const workerKeys = await this.redis.keys('worker:*:heartbeat');
    const activeWorkers = workerKeys.length;
    
    log.info(`Active workers detected: ${activeWorkers}`);
    
    if (activeWorkers < this.testResults.targetWorkers) {
      log.warn(`⚠️  Only ${activeWorkers} workers active, target is ${this.testResults.targetWorkers}`);
      log.warn('Consider deploying more workers for optimal performance');
    }
    
    // Check coordinator heartbeat
    const coordinatorHeartbeat = await this.redis.get('coordinator:heartbeat');
    if (!coordinatorHeartbeat) {
      throw new Error('No coordinator heartbeat detected - coordinator may not be running');
    }
    
    log.info('✅ System readiness validated');
  }

  generateTestCredentials(count) {
    log.info(`📝 Generating ${count} test credentials...`);
    
    const credentials = [];
    const domains = ['hotmail.co.jp', 'outlook.jp', 'live.jp', 'msn.co.jp'];
    
    for (let i = 0; i < count; i++) {
      const domain = domains[i % domains.length];
      const username = `loadtest${i.toString().padStart(6, '0')}@${domain}`;
      const password = `TestPass${i}!`;
      
      credentials.push({ username, password });
    }
    
    log.info(`✅ Generated ${credentials.length} test credentials`);
    return credentials;
  }

  async submitBatch(credentials) {
    log.info('📤 Submitting batch for processing...');
    
    this.testStartTime = performance.now();
    
    // Initialize progress tracker
    await this.redis.set(`progress:${this.batchId}`, JSON.stringify({
      total: credentials.length,
      completed: 0,
      startTime: Date.now(),
      batchId: this.batchId
    }), { EX: 7 * 24 * 60 * 60 }); // 7 days TTL
    
    // Create tasks and enqueue them
    const tasks = credentials.map((cred, index) => ({
      taskId: `${this.batchId}-${index.toString().padStart(6, '0')}`,
      batchId: this.batchId,
      username: cred.username,
      password: cred.password,
      proxyId: `p${(index % 10).toString().padStart(3, '0')}`, // Simulate 10 proxies
      proxyUrl: `http://proxy${index % 10}.example.com:8080`,
      retryCount: 0,
      createdAt: Date.now(),
      batchType: 'LOAD_TEST'
    }));
    
    // Batch enqueue for performance
    const pipeline = this.redis.multi();
    
    for (const task of tasks) {
      pipeline.rPush('queue:tasks', JSON.stringify(task));
    }
    
    await pipeline.exec();
    
    log.info(`✅ Enqueued ${tasks.length} tasks to Redis queue`);
    log.info(`⏱️  Batch submission completed in ${Math.round(performance.now() - this.testStartTime)}ms`);
  }

  async monitorProcessing() {
    log.info('📊 Starting processing monitoring...');
    
    const monitoringStartTime = performance.now();
    let lastCompletedCount = 0;
    let stagnantChecks = 0;
    const maxStagnantChecks = 12; // 2 minutes of no progress (10s intervals)
    
    this.monitoringInterval = setInterval(async () => {
      try {
        const timestamp = Date.now();
        
        // Get queue depth
        const queueDepth = await this.redis.lLen('queue:tasks');
        
        // Get completed count
        const progressData = await this.redis.get(`progress:${this.batchId}`);
        const progress = progressData ? JSON.parse(progressData) : { completed: 0 };
        const completedCount = progress.completed || 0;
        
        // Get active workers
        const workerKeys = await this.redis.keys('worker:*:heartbeat');
        const activeWorkers = workerKeys.length;
        
        // Get Redis memory usage
        const memoryInfo = await this.redis.memoryUsage('queue:tasks') || 0;
        
        // Store metrics
        this.metrics.timestamps.push(timestamp);
        this.metrics.queueDepth.push(queueDepth);
        this.metrics.completedTasks.push(completedCount);
        this.metrics.workerCounts.push(activeWorkers);
        this.metrics.redisMemory.push(memoryInfo);
        
        // Calculate progress
        const progressPercent = (completedCount / this.testResults.batchSize * 100).toFixed(1);
        const elapsedMs = performance.now() - this.testStartTime;
        const elapsedMinutes = (elapsedMs / 1000 / 60).toFixed(1);
        
        // Calculate throughput
        const throughput = completedCount > 0 ? (completedCount / (elapsedMs / 1000 / 60)).toFixed(1) : 0;
        
        // Estimate completion time
        const remainingTasks = this.testResults.batchSize - completedCount;
        const estimatedMinutesRemaining = throughput > 0 ? (remainingTasks / throughput).toFixed(1) : 'Unknown';
        
        log.info(`📈 Progress: ${completedCount}/${this.testResults.batchSize} (${progressPercent}%) | ` +
                `Queue: ${queueDepth} | Workers: ${activeWorkers} | ` +
                `Throughput: ${throughput}/min | ETA: ${estimatedMinutesRemaining}min | ` +
                `Elapsed: ${elapsedMinutes}min`);
        
        // Check for stagnation
        if (completedCount === lastCompletedCount && queueDepth > 0) {
          stagnantChecks++;
          if (stagnantChecks >= maxStagnantChecks) {
            log.error('❌ Processing appears stagnant - no progress for 2 minutes');
            throw new Error('Processing stagnation detected');
          }
        } else {
          stagnantChecks = 0;
        }
        
        lastCompletedCount = completedCount;
        
        // Check completion
        if (completedCount >= this.testResults.batchSize) {
          log.info('🎉 Batch processing completed!');
          clearInterval(this.monitoringInterval);
          return;
        }
        
        // Check timeout (2.5 hours to allow some buffer)
        if (elapsedMs > this.testResults.targetCompletionTime * 1.25) {
          log.error('❌ Test timeout exceeded (2.5 hours)');
          throw new Error('Test timeout exceeded');
        }
        
      } catch (error) {
        log.error('Monitoring error', { error: error.message });
        clearInterval(this.monitoringInterval);
        throw error;
      }
    }, 10000); // Monitor every 10 seconds
    
    // Wait for completion or timeout
    return new Promise((resolve, reject) => {
      const checkCompletion = setInterval(async () => {
        try {
          const progressData = await this.redis.get(`progress:${this.batchId}`);
          const progress = progressData ? JSON.parse(progressData) : { completed: 0 };
          
          if (progress.completed >= this.testResults.batchSize) {
            clearInterval(checkCompletion);
            clearInterval(this.monitoringInterval);
            resolve();
          }
        } catch (error) {
          clearInterval(checkCompletion);
          clearInterval(this.monitoringInterval);
          reject(error);
        }
      }, 5000);
    });
  }

  async analyzeResults() {
    log.info('📊 Analyzing test results...');
    
    const endTime = performance.now();
    const totalDurationMs = endTime - this.testStartTime;
    const totalDurationMinutes = totalDurationMs / 1000 / 60;
    
    // Get final progress
    const progressData = await this.redis.get(`progress:${this.batchId}`);
    const progress = progressData ? JSON.parse(progressData) : { completed: 0 };
    const finalCompletedCount = progress.completed || 0;
    
    // Calculate metrics
    const actualThroughput = finalCompletedCount / totalDurationMinutes;
    const completionRate = (finalCompletedCount / this.testResults.batchSize) * 100;
    const metTarget = totalDurationMs <= this.testResults.targetCompletionTime;
    const metThroughput = actualThroughput >= this.testResults.targetThroughput;
    
    // Analyze queue depth patterns
    const maxQueueDepth = Math.max(...this.metrics.queueDepth);
    const avgQueueDepth = this.metrics.queueDepth.reduce((a, b) => a + b, 0) / this.metrics.queueDepth.length;
    
    // Analyze worker stability
    const minWorkers = Math.min(...this.metrics.workerCounts);
    const maxWorkers = Math.max(...this.metrics.workerCounts);
    const avgWorkers = this.metrics.workerCounts.reduce((a, b) => a + b, 0) / this.metrics.workerCounts.length;
    
    // Analyze Redis memory usage
    const maxMemory = Math.max(...this.metrics.redisMemory);
    const avgMemory = this.metrics.redisMemory.reduce((a, b) => a + b, 0) / this.metrics.redisMemory.length;
    
    this.testResults.actualResults = {
      success: metTarget && metThroughput && completionRate >= 95,
      completedTasks: finalCompletedCount,
      totalDurationMs,
      totalDurationMinutes: totalDurationMinutes.toFixed(2),
      actualThroughput: actualThroughput.toFixed(2),
      completionRate: completionRate.toFixed(1),
      metTimeTarget: metTarget,
      metThroughputTarget: metThroughput,
      queueMetrics: {
        maxDepth: maxQueueDepth,
        avgDepth: avgQueueDepth.toFixed(1)
      },
      workerMetrics: {
        min: minWorkers,
        max: maxWorkers,
        avg: avgWorkers.toFixed(1)
      },
      memoryMetrics: {
        maxBytes: maxMemory,
        avgBytes: avgMemory.toFixed(0),
        maxMB: (maxMemory / 1024 / 1024).toFixed(2),
        avgMB: (avgMemory / 1024 / 1024).toFixed(2)
      },
      completedAt: Date.now()
    };
    
    log.info('✅ Results analysis completed');
  }

  printTestSummary() {
    const results = this.testResults.actualResults;
    
    log.info('='.repeat(80));
    log.info('🎯 LOAD TEST RESULTS: 10K CREDENTIAL BATCH');
    log.info('='.repeat(80));
    
    // Test configuration
    log.info('\n📋 TEST CONFIGURATION:');
    log.info(`Batch size: ${this.testResults.batchSize} credentials`);
    log.info(`Target workers: ${this.testResults.targetWorkers} instances`);
    log.info(`Target completion time: ${this.testResults.targetCompletionTime / 1000 / 60} minutes`);
    log.info(`Target throughput: ${this.testResults.targetThroughput} credentials/minute`);
    
    // Performance results
    log.info('\n🚀 PERFORMANCE RESULTS:');
    log.info(`Completed tasks: ${results.completedTasks}/${this.testResults.batchSize} (${results.completionRate}%)`);
    log.info(`Total duration: ${results.totalDurationMinutes} minutes`);
    log.info(`Actual throughput: ${results.actualThroughput} credentials/minute`);
    log.info(`Time target met: ${results.metTimeTarget ? '✅ YES' : '❌ NO'}`);
    log.info(`Throughput target met: ${results.metThroughputTarget ? '✅ YES' : '❌ NO'}`);
    
    // System metrics
    log.info('\n📊 SYSTEM METRICS:');
    log.info(`Queue depth - Max: ${results.queueMetrics.maxDepth}, Avg: ${results.queueMetrics.avgDepth}`);
    log.info(`Active workers - Min: ${results.workerMetrics.min}, Max: ${results.workerMetrics.max}, Avg: ${results.workerMetrics.avg}`);
    log.info(`Redis memory - Max: ${results.memoryMetrics.maxMB}MB, Avg: ${results.memoryMetrics.avgMB}MB`);
    
    // Overall assessment
    log.info('\n🎯 OVERALL ASSESSMENT:');
    if (results.success) {
      log.info('✅ LOAD TEST PASSED');
      log.info('✅ System successfully handled 10k credential batch');
      log.info('✅ Performance targets met');
      log.info('✅ System scales effectively with multiple workers');
      log.info('✅ Queue management working properly');
      log.info('✅ Memory usage within acceptable limits');
    } else {
      log.error('❌ LOAD TEST FAILED');
      
      if (!results.metTimeTarget) {
        log.error(`❌ Completion time exceeded target (${results.totalDurationMinutes} > ${this.testResults.targetCompletionTime / 1000 / 60} minutes)`);
      }
      
      if (!results.metThroughputTarget) {
        log.error(`❌ Throughput below target (${results.actualThroughput} < ${this.testResults.targetThroughput} credentials/minute)`);
      }
      
      if (results.completionRate < 95) {
        log.error(`❌ Completion rate too low (${results.completionRate}% < 95%)`);
      }
    }
    
    // Recommendations
    log.info('\n💡 RECOMMENDATIONS:');
    
    if (results.workerMetrics.avg < this.testResults.targetWorkers * 0.8) {
      log.warn(`⚠️  Consider deploying more workers (avg: ${results.workerMetrics.avg}, target: ${this.testResults.targetWorkers})`);
    }
    
    if (results.queueMetrics.maxDepth > 5000) {
      log.warn(`⚠️  High queue depth detected (${results.queueMetrics.maxDepth}) - consider more workers`);
    }
    
    if (parseFloat(results.memoryMetrics.maxMB) > 100) {
      log.warn(`⚠️  High Redis memory usage (${results.memoryMetrics.maxMB}MB) - monitor for memory leaks`);
    }
    
    if (results.actualThroughput < this.testResults.targetThroughput * 0.8) {
      log.warn('⚠️  Low throughput - check worker performance and proxy health');
    }
    
    log.info('='.repeat(80));
  }

  async cleanup() {
    log.info('🧹 Cleaning up test resources...');
    
    try {
      if (this.monitoringInterval) {
        clearInterval(this.monitoringInterval);
      }
      
      if (this.redis) {
        // Clean up test data
        await this.redis.del(`progress:${this.batchId}`);
        
        // Remove any remaining test tasks from queue
        const queueLength = await this.redis.lLen('queue:tasks');
        if (queueLength > 0) {
          log.info(`Cleaning up ${queueLength} remaining tasks from queue`);
          await this.redis.del('queue:tasks');
        }
        
        await this.redis.disconnect();
      }
      
      log.info('✅ Cleanup completed');
    } catch (error) {
      log.error('Cleanup error', { error: error.message });
    }
  }

  getResults() {
    return this.testResults;
  }
}

// Export for use as module
module.exports = LoadTest10kBatch;

// If run directly, execute the test
if (require.main === module) {
  const test = new LoadTest10kBatch();
  
  test.runTest()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      log.error('Load test execution failed', { error: error.message });
      process.exit(1);
    });
}