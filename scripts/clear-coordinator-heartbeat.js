// Clear old coordinator heartbeat from Redis
require('dotenv').config({ path: '.env.coordinator' });

const { getRedisClient } = require('../shared/redis/client');
const { COORDINATOR_HEARTBEAT } = require('../shared/redis/keys');
const { createLogger } = require('../logger');

const log = createLogger('clear-heartbeat');

async function clearHeartbeat() {
  try {
    log.info('Connecting to Redis...');
    const redis = getRedisClient();
    
    log.info('Checking for existing coordinator heartbeat...');
    const existing = await redis.executeCommand('get', COORDINATOR_HEARTBEAT.key);
    
    if (existing) {
      const data = JSON.parse(existing);
      log.info('Found existing heartbeat:', {
        coordinatorId: data.coordinatorId,
        timestamp: new Date(data.timestamp).toISOString(),
        age: Math.round((Date.now() - data.timestamp) / 1000) + 's'
      });
      
      log.info('Deleting coordinator heartbeat...');
      await redis.executeCommand('del', COORDINATOR_HEARTBEAT.key);
      log.success('Coordinator heartbeat cleared!');
    } else {
      log.info('No coordinator heartbeat found');
    }
    
    await redis.close();
    process.exit(0);
    
  } catch (error) {
    log.error('Error:', error.message);
    process.exit(1);
  }
}

clearHeartbeat();
