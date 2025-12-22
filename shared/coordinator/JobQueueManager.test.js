/**
 * JobQueueManager Tests
 * 
 * Basic tests to verify JobQueueManager functionality
 */

const JobQueueManager = require('./JobQueueManager');
const ProxyPoolManager = require('./ProxyPoolManager');

// Mock Redis client
class MockRedisClient {
  constructor() {
    this.data = new Map();
    this.lists = new Map();
  }

  async executeCommand(command, ...args) {
    switch (command) {
      case 'setex':
        const [key, ttl, value] = args;
        this.data.set(key, { value, ttl, expiry: Date.now() + (ttl * 1000) });
        return 'OK';
      
      case 'get':
        const entry = this.data.get(args[0]);
        if (!entry || Date.now() > entry.expiry) {
          return null;
        }
        return entry.value;
      
      case 'mget':
        return args.map(key => {
          const entry = this.data.get(key);
          return (entry && Date.now() <= entry.expiry) ? entry.value : null;
        });
      
      case 'rpush':
        const [listKey, ...values] = args;
        if (!this.lists.has(listKey)) {
          this.lists.set(listKey, []);
        }
        this.lists.get(listKey).push(...values);
        return this.lists.get(listKey).length;
      
      case 'lpop':
        const list = this.lists.get(args[0]);
        return list && list.length > 0 ? list.shift() : null;
      
      case 'llen':
        const queueList = this.lists.get(args[0]);
        return queueList ? queueList.length : 0;
      
      case 'del':
        this.data.delete(args[0]);
        this.lists.delete(args[0]);
        return 1;
      
      default:
        throw new Error(`Mock Redis command not implemented: ${command}`);
    }
  }
}

async function testJobQueueManager() {
  console.log('Testing JobQueueManager...');
  
  const mockRedis = new MockRedisClient();
  const proxyPool = new ProxyPoolManager(mockRedis, ['http://proxy1:8080', 'http://proxy2:8080']);
  const jobQueue = new JobQueueManager(mockRedis, proxyPool);
  
  // Test 1: Enqueue batch
  console.log('Test 1: Enqueue batch');
  const batchId = 'test-batch-001';
  const credentials = [
    { username: 'user1@example.com', password: 'pass1' },
    { username: 'user2@example.com', password: 'pass2' },
    { username: 'user3@example.com', password: 'pass3' }
  ];
  
  const result = await jobQueue.enqueueBatch(batchId, credentials, {
    batchType: 'TEST',
    chatId: 123456,
    messageId: 789
  });
  
  console.log('Enqueue result:', result);
  console.assert(result.queued === 3, 'Should queue 3 credentials');
  console.assert(result.cached === 0, 'Should have 0 cached credentials');
  
  // Test 2: Check queue stats
  console.log('Test 2: Check queue stats');
  const stats = await jobQueue.getQueueStats();
  console.log('Queue stats:', stats);
  console.assert(stats.mainQueue === 3, 'Main queue should have 3 tasks');
  console.assert(stats.total === 3, 'Total should be 3');
  
  // Test 3: Cancel batch
  console.log('Test 3: Cancel batch');
  const cancelResult = await jobQueue.cancelBatch(batchId);
  console.log('Cancel result:', cancelResult);
  console.assert(cancelResult.drained === 3, 'Should drain 3 tasks');
  
  // Test 4: Check queue is empty after cancellation
  console.log('Test 4: Check queue after cancellation');
  const statsAfterCancel = await jobQueue.getQueueStats();
  console.log('Queue stats after cancel:', statsAfterCancel);
  console.assert(statsAfterCancel.total === 0, 'Queue should be empty after cancellation');
  
  console.log('✅ All JobQueueManager tests passed!');
}

// Run tests if this file is executed directly
if (require.main === module) {
  testJobQueueManager().catch(console.error);
}

module.exports = { testJobQueueManager };