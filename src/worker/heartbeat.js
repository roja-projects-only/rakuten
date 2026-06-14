/**
 * Worker Heartbeat — building and sending heartbeat payloads to Redis.
 *
 * Separated from WorkerNode so the reporting logic can be tested and
 * maintained independently from the main worker loop.
 */

const { WORKER_HEARTBEAT, PUBSUB_CHANNELS } = require('../shared/redis/keys');

/**
 * Build a heartbeat payload from the current worker state.
 *
 * @param {Object} state
 * @param {string}   state.workerId
 * @param {number}   state.tasksCompleted
 * @param {number}   state.activeTaskCount
 * @param {string[]} state.activeTaskIds     Array of task IDs currently being processed
 * @param {number}   state.concurrency
 * @param {number}   state.startTime         Timestamp the worker started (ms)
 * @returns {Object} heartbeatData
 */
function buildHeartbeatData(state) {
  const {
    workerId,
    tasksCompleted,
    activeTaskCount,
    activeTaskIds = [],
    concurrency,
    startTime,
  } = state;

  return {
    workerId,
    timestamp: Date.now(),
    tasksCompleted,
    concurrency,
    activeTasks: activeTaskCount,
    taskIds: activeTaskIds,
    utilization: concurrency > 0
      ? Math.round((activeTaskCount / concurrency) * 100)
      : 0,
    uptime: Date.now() - startTime,
    memoryUsage: process.memoryUsage(),
  };
}

/**
 * Persist heartbeat to Redis and publish to the heartbeat channel.
 *
 * @param {import('../shared/redis/client').RedisClient} redis
 * @param {string} workerId
 * @param {Object} heartbeatData  Previously built by buildHeartbeatData()
 */
async function sendHeartbeatCommands(redis, workerId, heartbeatData) {
  // SET worker heartbeat with TTL
  await redis.executeCommand(
    'setex',
    WORKER_HEARTBEAT.generate(workerId),
    WORKER_HEARTBEAT.ttl,
    JSON.stringify(heartbeatData),
  );

  // PUBLISH to worker_heartbeats channel
  await redis.executeCommand(
    'publish',
    PUBSUB_CHANNELS.workerHeartbeats,
    JSON.stringify(heartbeatData),
  );
}

module.exports = { buildHeartbeatData, sendHeartbeatCommands };
