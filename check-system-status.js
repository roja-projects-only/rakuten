#!/usr/bin/env node

/**
 * Check distributed system status
 */

const { getRedisClient } = require('./shared/redis/client');
const { createLogger } = require('./logger');
const { WORKER_HEARTBEAT, COORDINATOR_HEARTBEAT, JOB_QUEUE } = require('./shared/redis/keys');

const log = createLogger('status-check');

async function checkSystemStatus() {
  const redis = getRedisClient();
  
  try {
    await redis.connect();
    log.info('✓ Redis connection successful');
    
    // Check coordinator heartbeat
    const coordinatorHeartbeat = await redis.executeCommand('get', COORDINATOR_HEARTBEAT.key);
    if (coordinatorHeartbeat) {
      const data = JSON.parse(coordinatorHeartbeat);
      const age = Date.now() - data.timestamp;
      log.info(`✓ Coordinator active (${data.coordinatorId}, ${Math.round(age/1000)}s ago)`);
    } else {
      log.warn('✗ No coordinator heartbeat found');
    }
    
    // Check worker heartbeats
    const workerKeys = await redis.executeCommand('keys', WORKER_HEARTBEAT.pattern.replace('{workerId}', '*'));
    log.info(`✓ Found ${workerKeys.length} worker heartbeats`);
    
    for (const key of workerKeys) {
      const heartbeat = await redis.executeCommand('get', key);
      if (heartbeat) {
        const data = JSON.parse(heartbeat);
        const age = Date.now() - data.timestamp;
        const workerId = key.split(':')[1];
        log.info(`  - Worker ${workerId}: ${Math.round(age/1000)}s ago (${data.tasksCompleted || 0} tasks)`);
      }
    }
    
    // Check job queue depth
    const queueDepth = await redis.executeCommand('llen', JOB_QUEUE.tasks);
    log.info(`✓ Job queue depth: ${queueDepth} tasks`);
    
    // Check progress trackers
    const progressKeys = await redis.executeCommand('keys', 'progress:*');
    const activeProgressKeys = progressKeys.filter(key => !key.includes(':count') && !key.includes(':valid') && !key.includes(':counts'));
    log.info(`✓ Active batches: ${activeProgressKeys.length}`);
    
    if (activeProgressKeys.length > 0) {
      for (const key of activeProgressKeys.slice(0, 5)) { // Show first 5
        const batchId = key.split(':')[1];
        const progressData = await redis.executeCommand('get', key);
        if (progressData) {
          const data = JSON.parse(progressData);
          const counterKey = `progress:${batchId}:count`;
          const completed = await redis.executeCommand('get', counterKey) || 0;
          log.info(`  - Batch ${batchId}: ${completed}/${data.total} completed`);
        }
      }
    }
    
    // System health summary
    const isHealthy = coordinatorHeartbeat && workerKeys.length > 0;
    log.info('');
    log.info('=== SYSTEM STATUS ===');
    log.info(`Overall Health: ${isHealthy ? '✓ HEALTHY' : '✗ DEGRADED'}`);
    log.info(`Mode: ${coordinatorHeartbeat ? 'Distributed' : 'Single-node fallback'}`);
    log.info(`Workers: ${workerKeys.length} active`);
    log.info(`Queue: ${queueDepth} pending tasks`);
    log.info(`Batches: ${activeProgressKeys.length} in progress`);
    
  } catch (error) {
    log.error('System status check failed:', error.message);
  } finally {
    await redis.close();
  }
}

if (require.main === module) {
  checkSystemStatus().catch(console.error);
}

module.exports = { checkSystemStatus };