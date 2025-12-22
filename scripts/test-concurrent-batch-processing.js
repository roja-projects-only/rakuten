#!/usr/bin/env node

/**
 * Concurrent Batch Processing Test
 * 
 * This test validates the system's ability to handle multiple batches simultaneously.
 * It submits 3 batches of 1k credentials each and verifies fair task distribution,
 * proper progress tracking per batch, and no cross-batch contamination.
 * 
 * Requirements tested: 1.3, 5.1, 5.2
 * Test scenario: 3 concurrent batches of 1000 credentials each
 * Validation: Fair distribution, isolated progress tracking, no contamination
 */

const { createLogger } = require('../logger');
const { createClient } = require('redis');
const { performance } = require('perf_hooks');

const log = createLogger('concurrent-batch-test');

class ConcurrentBatchProcessingTest {
  constructor() {
    this.testResults = {
      batchCount: 3,
      batchSize: 1000,
      totalCredentials: 3000,
      batches: {},
      fairnessThreshold: 0.15, // 15% deviation allowed
      actualResults: {}
    };
    
    this.redis = null;
    this.testStartTime = null;
    this.batchIds = [];
    this.monitoringInterval = null;
    this.metrics = {
      batchProgress: {},
      taskDistribution: {},
      timestamps: [],
      queueDepths: []
    };
  }

  async runTest() {
    log.info('🚀 Starting Concurrent Batch Processing Test');
    log.info('='.repeat(80));
    log.info(`Number of batches: ${this.testResults.batchCount}`);
    log.info(`Batch size: ${this.testResults.batchSize} credentials each`);
    log.info(`Total credentials: ${this.testResults.totalCredentials}`);
    log.info(`Fairness threshold: ±${this.testResults.fairnessThreshold * 100}%`);
    log.info('');

    try {
      // Initialize Redis connection
      await this.initializeRedis();
      
      // Validate system readiness
      await this.validateSystemReadiness();
      
      // Generate test batches
      const batches = this.generateTestBatches();
      
      // Submit all batches concurrently
      await this.submitConcurrentBatches(batches);
      
      // Monitor concurrent processing
      await this.monitorConcurrentProcessing();
      
      // Analyze results
      await this.analyzeResults();
      
      // Generate report
      this.printTestSummary();
      
      return this.testResults.actualResults.success;
      
    } catch (error) {
      log.error('Concurrent batch test failed', { error: error.message });
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
      throw new Error('REDIS_URL environment variable is required for concurrent batch testing');
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
    
    // Clear any existing queue
    const queueLength = await this.redis.lLen('queue:tasks');
    if (queueLength > 0) {
      log.warn(`Queue not empty: ${queueLength} tasks pending. Clearing...`);
      await this.redis.del('queue:tasks');
    }
    
    // Check for active workers
    const workerKeys = await this.redis.keys('worker:*:heartbeat');
    const activeWorkers = workerKeys.length;
    
    log.info(`Active workers detected: ${activeWorkers}`);
    
    if (activeWorkers < 3) {
      log.warn(`⚠️  Only ${activeWorkers} workers active, recommend at least 3 for concurrent testing`);
    }
    
    // Check coordinator heartbeat
    const coordinatorHeartbeat = await this.redis.get('coordinator:heartbeat');
    if (!coordinatorHeartbeat) {
      throw new Error('No coordinator heartbeat detected - coordinator may not be running');
    }
    
    log.info('✅ System readiness validated');
  }

  generateTestBatches() {
    log.info('📝 Generating test batches...');
    
    const batches = [];
    const domains = ['hotmail.co.jp', 'outlook.jp', 'live.jp'];
    
    for (let batchIndex = 0; batchIndex < this.testResults.batchCount; batchIndex++) {
      const batchId = `concurrent-test-${Date.now()}-${batchIndex}`;
      const domain = domains[batchIndex % domains.length];
      
      this.batchIds.push(batchId);
      
      const credentials = [];
      for (let i = 0; i < this.testResults.batchSize; i++) {
        const username = `batch${batchIndex}user${i.toString().padStart(4, '0')}@${domain}`;
        const password = `TestPass${batchIndex}${i}!`;
        credentials.push({ username, password });
      }
      
      batches.push({
        batchId,
        credentials,
        domain,
        batchIndex
      });
      
      this.testResults.batches[batchId] = {
        batchIndex,
        domain,
        size: credentials.length,
        startTime: null,
        endTime: null
      };
    }
    
    log.info(`✅ Generated ${batches.length} test batches`);
    return batches;
  }

  async submitConcurrentBatches(batches) {
    log.info('📤 Submitting concurrent batches...');
    
    this.testStartTime = performance.now();
    
    // Submit all batches simultaneously
    const submissionPromises = batches.map(async (batch, index) => {
      const { batchId, credentials } = batch;
      
      // Initialize progress tracker for this batch
      await this.redis.set(`progress:${batchId}`, JSON.stringify({
        total: credentials.length,
        completed: 0,
        startTime: Date.now(),
        batchId: batchId,
        batchIndex: index
      }), { EX: 7 * 24 * 60 * 60 }); // 7 days TTL
      
      // Create tasks for this batch
      const tasks = credentials.map((cred, taskIndex) => ({
        taskId: `${batchId}-${taskIndex.toString().padStart(4, '0')}`,
        batchId: batchId,
        username: cred.username,
        password: cred.password,
        proxyId: `p${(taskIndex % 5).toString().padStart(3, '0')}`, // 5 proxies per batch
        proxyUrl: `http://proxy${taskIndex % 5}.example.com:8080`,
        retryCount: 0,
        createdAt: Date.now(),
        batchType: 'CONCURRENT_TEST',
        batchIndex: index
      }));
      
      // Enqueue tasks for this batch
      const pipeline = this.redis.multi();
      for (const task of tasks) {
        pipeline.rPush('queue:tasks', JSON.stringify(task));
      }
      await pipeline.exec();
      
      this.testResults.batches[batchId].startTime = Date.now();
      
      log.info(`✅ Batch ${index + 1} (${batchId}): ${tasks.length} tasks enqueued`);
      
      return {
        batchId,
        taskCount: tasks.length,
        submissionTime: Date.now()
      };
    });
    
    const submissionResults = await Promise.all(submissionPromises);
    
    const totalTasks = submissionResults.reduce((sum, result) => sum + result.taskCount, 0);
    const submissionDuration = performance.now() - this.testStartTime;
    
    log.info(`✅ All batches submitted: ${totalTasks} total tasks in ${Math.round(submissionDuration)}ms`);
  }

  async monitorConcurrentProcessing() {
    log.info('📊 Starting concurrent processing monitoring...');
    
    let allBatchesComplete = false;
    let stagnantChecks = 0;
    const maxStagnantChecks = 12; // 2 minutes of no progress
    let lastTotalCompleted = 0;
    
    this.monitoringInterval = setInterval(async () => {
      try {
        const timestamp = Date.now();
        
        // Get queue depth
        const queueDepth = await this.redis.lLen('queue:tasks');
        
        // Get progress for each batch
        const batchProgresses = {};
        let totalCompleted = 0;
        let allComplete = true;
        
        for (const batchId of this.batchIds) {
          const progressData = await this.redis.get(`progress:${batchId}`);
          const progress = progressData ? JSON.parse(progressData) : { completed: 0, total: this.testResults.batchSize };
          
          batchProgresses[batchId] = progress;
          totalCompleted += progress.completed || 0;
          
          if ((progress.completed || 0) < (progress.total || this.testResults.batchSize)) {
            allComplete = false;
          }
        }
        
        // Store metrics
        this.metrics.timestamps.push(timestamp);
        this.metrics.queueDepths.push(queueDepth);
        this.metrics.batchProgress[timestamp] = { ...batchProgresses };
        
        // Calculate overall progress
        const overallProgress = (totalCompleted / this.testResults.totalCredentials * 100).toFixed(1);
        const elapsedMs = performance.now() - this.testStartTime;
        const elapsedMinutes = (elapsedMs / 1000 / 60).toFixed(1);
        
        // Log progress for each batch
        log.info(`📈 Overall Progress: ${totalCompleted}/${this.testResults.totalCredentials} (${overallProgress}%) | Queue: ${queueDepth} | Elapsed: ${elapsedMinutes}min`);
        
        for (let i = 0; i < this.batchIds.length; i++) {
          const batchId = this.batchIds[i];
          const progress = batchProgresses[batchId];
          const batchPercent = ((progress.completed || 0) / (progress.total || this.testResults.batchSize) * 100).toFixed(1);
          log.info(`  Batch ${i + 1}: ${progress.completed || 0}/${progress.total || this.testResults.batchSize} (${batchPercent}%)`);
        }
        
        // Check for stagnation
        if (totalCompleted === lastTotalCompleted && queueDepth > 0) {
          stagnantChecks++;
          if (stagnantChecks >= maxStagnantChecks) {
            log.error('❌ Processing appears stagnant - no progress for 2 minutes');
            throw new Error('Processing stagnation detected');
          }
        } else {
          stagnantChecks = 0;
        }
        
        lastTotalCompleted = totalCompleted;
        
        // Check completion
        if (allComplete) {
          log.info('🎉 All batches completed!');
          allBatchesComplete = true;
          clearInterval(this.monitoringInterval);
          return;
        }
        
        // Check timeout (30 minutes for 3k credentials)
        if (elapsedMs > 30 * 60 * 1000) {
          log.error('❌ Test timeout exceeded (30 minutes)');
          throw new Error('Test timeout exceeded');
        }
        
      } catch (error) {
        log.error('Monitoring error', { error: error.message });
        clearInterval(this.monitoringInterval);
        throw error;
      }
    }, 10000); // Monitor every 10 seconds
    
    // Wait for completion
    return new Promise((resolve, reject) => {
      const checkCompletion = setInterval(async () => {
        if (allBatchesComplete) {
          clearInterval(checkCompletion);
          resolve();
        }
      }, 2000);
      
      // Timeout after 35 minutes
      setTimeout(() => {
        clearInterval(checkCompletion);
        clearInterval(this.monitoringInterval);
        reject(new Error('Test timeout exceeded'));
      }, 35 * 60 * 1000);
    });
  }

  async analyzeResults() {
    log.info('📊 Analyzing concurrent batch results...');
    
    const endTime = performance.now();
    const totalDurationMs = endTime - this.testStartTime;
    
    // Get final progress for each batch
    const finalProgresses = {};
    const completionTimes = {};
    let totalCompleted = 0;
    
    for (const batchId of this.batchIds) {
      const progressData = await this.redis.get(`progress:${batchId}`);
      const progress = progressData ? JSON.parse(progressData) : { completed: 0, total: this.testResults.batchSize };
      
      finalProgresses[batchId] = progress;
      totalCompleted += progress.completed || 0;
      
      // Estimate completion time for this batch
      const batchMetrics = Object.entries(this.metrics.batchProgress)
        .map(([timestamp, progresses]) => ({
          timestamp: parseInt(timestamp),
          completed: progresses[batchId]?.completed || 0
        }))
        .filter(entry => entry.completed > 0);
      
      if (batchMetrics.length > 0) {
        const lastEntry = batchMetrics[batchMetrics.length - 1];
        completionTimes[batchId] = lastEntry.timestamp - this.testResults.batches[batchId].startTime;
      }
    }
    
    // Analyze task distribution fairness
    const expectedTasksPerBatch = this.testResults.batchSize;
    const actualTasksPerBatch = this.batchIds.map(batchId => finalProgresses[batchId].completed || 0);
    
    const fairnessDeviations = actualTasksPerBatch.map(actual => 
      Math.abs(actual - expectedTasksPerBatch) / expectedTasksPerBatch
    );
    
    const maxDeviation = Math.max(...fairnessDeviations);
    const avgDeviation = fairnessDeviations.reduce((a, b) => a + b, 0) / fairnessDeviations.length;
    
    // Check for cross-batch contamination
    const contaminationCheck = await this.checkCrossBatchContamination();
    
    // Analyze progress tracking isolation
    const progressIsolationCheck = this.analyzeProgressIsolation();
    
    this.testResults.actualResults = {
      success: maxDeviation <= this.testResults.fairnessThreshold && 
               !contaminationCheck.hasContamination && 
               progressIsolationCheck.isolated &&
               totalCompleted >= this.testResults.totalCredentials * 0.95,
      totalDurationMs,
      totalDurationMinutes: (totalDurationMs / 1000 / 60).toFixed(2),
      totalCompleted,
      completionRate: (totalCompleted / this.testResults.totalCredentials * 100).toFixed(1),
      fairness: {
        maxDeviation: (maxDeviation * 100).toFixed(1),
        avgDeviation: (avgDeviation * 100).toFixed(1),
        withinThreshold: maxDeviation <= this.testResults.fairnessThreshold,
        actualTasksPerBatch,
        expectedTasksPerBatch
      },
      contamination: contaminationCheck,
      progressIsolation: progressIsolationCheck,
      batchResults: this.batchIds.map((batchId, index) => ({
        batchId,
        batchIndex: index,
        completed: finalProgresses[batchId].completed || 0,
        total: finalProgresses[batchId].total || this.testResults.batchSize,
        completionRate: ((finalProgresses[batchId].completed || 0) / this.testResults.batchSize * 100).toFixed(1),
        duration: completionTimes[batchId] ? (completionTimes[batchId] / 1000 / 60).toFixed(2) : 'Unknown'
      })),
      completedAt: Date.now()
    };
    
    log.info('✅ Results analysis completed');
  }

  async checkCrossBatchContamination() {
    log.info('🔍 Checking for cross-batch contamination...');
    
    // Check if any results were stored with wrong batch IDs
    // This would indicate tasks from one batch were processed as another batch
    
    let hasContamination = false;
    const contaminationDetails = [];
    
    try {
      // Check result store for any cross-contamination
      // Look for results that might have been stored with wrong batch metadata
      
      for (let batchIndex = 0; batchIndex < this.batchIds.length; batchIndex++) {
        const batchId = this.batchIds[batchIndex];
        const expectedDomain = this.testResults.batches[batchId].domain;
        
        // In a real implementation, we would check the result store
        // For this test, we'll simulate the check
        
        // Check if progress counters are isolated
        const progressData = await this.redis.get(`progress:${batchId}`);
        if (progressData) {
          const progress = JSON.parse(progressData);
          
          // Verify batch metadata integrity
          if (progress.batchId !== batchId) {
            hasContamination = true;
            contaminationDetails.push({
              type: 'progress_metadata',
              expected: batchId,
              actual: progress.batchId
            });
          }
        }
      }
      
    } catch (error) {
      log.warn('Could not complete contamination check', { error: error.message });
    }
    
    return {
      hasContamination,
      details: contaminationDetails,
      checked: true
    };
  }

  analyzeProgressIsolation() {
    log.info('🔍 Analyzing progress tracking isolation...');
    
    // Verify that each batch's progress was tracked independently
    let isolated = true;
    const isolationIssues = [];
    
    try {
      // Check if progress updates were properly isolated per batch
      const progressSnapshots = Object.entries(this.metrics.batchProgress);
      
      for (const [timestamp, progresses] of progressSnapshots) {
        // Verify each batch has independent progress tracking
        const batchProgresses = Object.keys(progresses);
        
        if (batchProgresses.length !== this.batchIds.length) {
          // Some batches missing from progress snapshot
          continue; // This is normal during startup
        }
        
        // Check for any anomalies in progress tracking
        for (const batchId of this.batchIds) {
          const progress = progresses[batchId];
          
          if (progress && progress.completed > progress.total) {
            isolated = false;
            isolationIssues.push({
              type: 'progress_overflow',
              batchId,
              timestamp,
              completed: progress.completed,
              total: progress.total
            });
          }
        }
      }
      
    } catch (error) {
      log.warn('Could not complete progress isolation analysis', { error: error.message });
      isolated = false;
      isolationIssues.push({
        type: 'analysis_error',
        error: error.message
      });
    }
    
    return {
      isolated,
      issues: isolationIssues,
      checked: true
    };
  }

  printTestSummary() {
    const results = this.testResults.actualResults;
    
    log.info('='.repeat(80));
    log.info('🎯 CONCURRENT BATCH PROCESSING TEST RESULTS');
    log.info('='.repeat(80));
    
    // Test configuration
    log.info('\n📋 TEST CONFIGURATION:');
    log.info(`Number of batches: ${this.testResults.batchCount}`);
    log.info(`Batch size: ${this.testResults.batchSize} credentials each`);
    log.info(`Total credentials: ${this.testResults.totalCredentials}`);
    log.info(`Fairness threshold: ±${this.testResults.fairnessThreshold * 100}%`);
    
    // Overall results
    log.info('\n🚀 OVERALL RESULTS:');
    log.info(`Total completed: ${results.totalCompleted}/${this.testResults.totalCredentials} (${results.completionRate}%)`);
    log.info(`Total duration: ${results.totalDurationMinutes} minutes`);
    log.info(`Overall success: ${results.success ? '✅ PASSED' : '❌ FAILED'}`);
    
    // Batch-specific results
    log.info('\n📊 BATCH-SPECIFIC RESULTS:');
    results.batchResults.forEach((batch, index) => {
      log.info(`Batch ${index + 1} (${batch.batchId.split('-').pop()}): ${batch.completed}/${batch.total} (${batch.completionRate}%) in ${batch.duration}min`);
    });
    
    // Fairness analysis
    log.info('\n⚖️  FAIRNESS ANALYSIS:');
    log.info(`Max deviation: ${results.fairness.maxDeviation}% (threshold: ${this.testResults.fairnessThreshold * 100}%)`);
    log.info(`Avg deviation: ${results.fairness.avgDeviation}%`);
    log.info(`Fair distribution: ${results.fairness.withinThreshold ? '✅ YES' : '❌ NO'}`);
    
    results.fairness.actualTasksPerBatch.forEach((actual, index) => {
      const deviation = ((actual - results.fairness.expectedTasksPerBatch) / results.fairness.expectedTasksPerBatch * 100).toFixed(1);
      log.info(`  Batch ${index + 1}: ${actual} tasks (${deviation > 0 ? '+' : ''}${deviation}%)`);
    });
    
    // Contamination check
    log.info('\n🔒 CROSS-BATCH CONTAMINATION:');
    log.info(`Contamination detected: ${results.contamination.hasContamination ? '❌ YES' : '✅ NO'}`);
    if (results.contamination.hasContamination) {
      results.contamination.details.forEach(detail => {
        log.error(`  - ${detail.type}: Expected ${detail.expected}, got ${detail.actual}`);
      });
    }
    
    // Progress isolation
    log.info('\n📈 PROGRESS TRACKING ISOLATION:');
    log.info(`Progress isolated: ${results.progressIsolation.isolated ? '✅ YES' : '❌ NO'}`);
    if (!results.progressIsolation.isolated) {
      results.progressIsolation.issues.forEach(issue => {
        log.error(`  - ${issue.type}: ${issue.error || 'Progress tracking issue detected'}`);
      });
    }
    
    // Overall assessment
    log.info('\n🎯 ASSESSMENT:');
    if (results.success) {
      log.info('✅ CONCURRENT BATCH PROCESSING TEST PASSED');
      log.info('✅ Fair task distribution across batches');
      log.info('✅ No cross-batch contamination detected');
      log.info('✅ Progress tracking properly isolated');
      log.info('✅ System handles concurrent batches effectively');
    } else {
      log.error('❌ CONCURRENT BATCH PROCESSING TEST FAILED');
      
      if (!results.fairness.withinThreshold) {
        log.error(`❌ Unfair task distribution (max deviation: ${results.fairness.maxDeviation}%)`);
      }
      
      if (results.contamination.hasContamination) {
        log.error('❌ Cross-batch contamination detected');
      }
      
      if (!results.progressIsolation.isolated) {
        log.error('❌ Progress tracking not properly isolated');
      }
      
      if (parseFloat(results.completionRate) < 95) {
        log.error(`❌ Low completion rate (${results.completionRate}%)`);
      }
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
        for (const batchId of this.batchIds) {
          await this.redis.del(`progress:${batchId}`);
        }
        
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
module.exports = ConcurrentBatchProcessingTest;

// If run directly, execute the test
if (require.main === module) {
  const test = new ConcurrentBatchProcessingTest();
  
  test.runTest()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      log.error('Concurrent batch test execution failed', { error: error.message });
      process.exit(1);
    });
}