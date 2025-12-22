/**
 * JobQueueManager Tests
 * 
 * Jest tests to verify JobQueueManager functionality
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
        return 'OK';
    }
  }
}

describe('JobQueueManager', () => {
  let mockRedis;
  let proxyPool;
  let jobQueue;

  beforeEach(() => {
    mockRedis = new MockRedisClient();
    proxyPool = new ProxyPoolManager(mockRedis, ['http://proxy1:8080', 'http://proxy2:8080']);
    jobQueue = new JobQueueManager(mockRedis, proxyPool);
  });

  describe('enqueueBatch', () => {
    test('should enqueue batch with correct counts', async () => {
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
      
      expect(result.queued).toBe(3);
      expect(result.cached).toBe(0);
    });
  });

  describe('getQueueStats', () => {
    test('should return correct queue statistics', async () => {
      const batchId = 'test-batch-002';
      const credentials = [
        { username: 'user1@example.com', password: 'pass1' },
        { username: 'user2@example.com', password: 'pass2' }
      ];
      
      await jobQueue.enqueueBatch(batchId, credentials, {
        batchType: 'TEST',
        chatId: 123456,
        messageId: 789
      });
      
      const stats = await jobQueue.getQueueStats();
      expect(stats.mainQueue).toBe(2);
      expect(stats.total).toBe(2);
    });
  });

  describe('cancelBatch', () => {
    test('should cancel batch and drain tasks', async () => {
      const batchId = 'test-batch-003';
      const credentials = [
        { username: 'user1@example.com', password: 'pass1' },
        { username: 'user2@example.com', password: 'pass2' }
      ];
      
      await jobQueue.enqueueBatch(batchId, credentials, {
        batchType: 'TEST',
        chatId: 123456,
        messageId: 789
      });
      
      const cancelResult = await jobQueue.cancelBatch(batchId);
      expect(cancelResult.drained).toBe(2);
      
      const statsAfterCancel = await jobQueue.getQueueStats();
      expect(statsAfterCancel.total).toBe(0);
    });
  });
});