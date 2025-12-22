/**
 * WorkerNode Unit Tests
 * 
 * Tests core functionality of the WorkerNode class including:
 * - Worker registration and heartbeat
 * - Task dequeuing and processing
 * - Result storage and progress tracking
 * - Graceful shutdown
 */

const WorkerNode = require('./WorkerNode');
const { generateWorkerId, JOB_QUEUE, TASK_LEASE } = require('../redis/keys');

// Mock dependencies
jest.mock('../../logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  })
}));

jest.mock('../../httpChecker', () => ({
  checkCredentials: jest.fn()
}));

jest.mock('../../automation/http/httpDataCapture', () => ({
  captureAccountData: jest.fn()
}));

jest.mock('../../automation/http/ipFetcher', () => ({
  fetchIpInfo: jest.fn()
}));

describe('WorkerNode', () => {
  let mockRedis;
  let worker;
  
  beforeEach(() => {
    // Mock Redis client
    mockRedis = {
      executeCommand: jest.fn(),
      isHealthy: jest.fn().mockResolvedValue(true)
    };
    
    // Create worker instance
    worker = new WorkerNode(mockRedis, {
      workerId: 'test-worker-001',
      heartbeatInterval: 1000, // 1 second for testing
      queueTimeout: 5000 // 5 seconds for testing
    });
    
    // Clear all mocks
    jest.clearAllMocks();
  });
  
  afterEach(() => {
    // Clean up timers
    if (worker.heartbeatTimer) {
      clearInterval(worker.heartbeatTimer);
    }
  });

  describe('Worker Registration', () => {
    test('should register worker with Redis on startup', async () => {
      await worker.registerWorker();
      
      expect(mockRedis.executeCommand).toHaveBeenCalledWith(
        'set',
        'worker:test-worker-001:info',
        expect.stringContaining('"workerId":"test-worker-001"')
      );
    });
    
    test('should generate unique worker ID if not provided', () => {
      const worker2 = new WorkerNode(mockRedis);
      expect(worker2.workerId).toMatch(/^[\w-]+-\d+-[\w]+-[\w]+$/);
    });
  });

  describe('Task Dequeuing', () => {
    test('should try retry queue first, then main queue', async () => {
      // Mock retry queue empty, main queue has task
      mockRedis.executeCommand
        .mockResolvedValueOnce(null) // retry queue empty
        .mockResolvedValueOnce(['queue:tasks', JSON.stringify({
          taskId: 'test-task-001',
          batchId: 'test-batch',
          username: 'test@example.com',
          password: 'password123'
        })]); // main queue has task
      
      const task = await worker.dequeueTask();
      
      expect(mockRedis.executeCommand).toHaveBeenCalledWith('blpop', JOB_QUEUE.retry, 1);
      expect(mockRedis.executeCommand).toHaveBeenCalledWith('blpop', JOB_QUEUE.tasks, 30);
      expect(task).toEqual({
        taskId: 'test-task-001',
        batchId: 'test-batch',
        username: 'test@example.com',
        password: 'password123'
      });
    });
    
    test('should return null on timeout', async () => {
      mockRedis.executeCommand.mockResolvedValue(null);
      
      const task = await worker.dequeueTask();
      
      expect(task).toBeNull();
    });
  });

  describe('Task Lease Management', () => {
    test('should acquire lease before processing task', async () => {
      const task = {
        taskId: 'test-task-001',
        batchId: 'test-batch',
        username: 'test@example.com',
        password: 'password123'
      };
      
      // Mock successful lease acquisition
      mockRedis.executeCommand.mockResolvedValueOnce('OK'); // lease acquired
      
      // Mock task processing (will be tested separately)
      jest.spyOn(worker, 'processTaskWithTimeout').mockResolvedValue();
      
      await worker.processTaskWithLease(task);
      
      const leaseKey = TASK_LEASE.generate(task.batchId, task.taskId);
      expect(mockRedis.executeCommand).toHaveBeenCalledWith(
        'set',
        leaseKey,
        expect.stringContaining('"workerId":"test-worker-001"'),
        'EX',
        TASK_LEASE.ttl,
        'NX'
      );
    });
    
    test('should skip task if lease already exists', async () => {
      const task = {
        taskId: 'test-task-001',
        batchId: 'test-batch',
        username: 'test@example.com',
        password: 'password123'
      };
      
      // Mock lease acquisition failure (already exists)
      mockRedis.executeCommand.mockResolvedValueOnce(null);
      
      jest.spyOn(worker, 'processTaskWithTimeout').mockResolvedValue();
      
      await worker.processTaskWithLease(task);
      
      // Should not call processTaskWithTimeout
      expect(worker.processTaskWithTimeout).not.toHaveBeenCalled();
    });
    
    test('should release lease after task completion', async () => {
      const task = {
        taskId: 'test-task-001',
        batchId: 'test-batch',
        username: 'test@example.com',
        password: 'password123'
      };
      
      mockRedis.executeCommand
        .mockResolvedValueOnce('OK') // lease acquired
        .mockResolvedValueOnce(1); // lease deleted
      
      jest.spyOn(worker, 'processTaskWithTimeout').mockResolvedValue();
      
      await worker.processTaskWithLease(task);
      
      const leaseKey = TASK_LEASE.generate(task.batchId, task.taskId);
      expect(mockRedis.executeCommand).toHaveBeenCalledWith('del', leaseKey);
    });
  });

  describe('Heartbeat Mechanism', () => {
    test('should send heartbeat with worker metadata', async () => {
      await worker.sendHeartbeat();
      
      expect(mockRedis.executeCommand).toHaveBeenCalledWith(
        'setex',
        'worker:test-worker-001:heartbeat',
        30,
        expect.stringContaining('"workerId":"test-worker-001"')
      );
      
      expect(mockRedis.executeCommand).toHaveBeenCalledWith(
        'publish',
        'worker_heartbeats',
        expect.stringContaining('"workerId":"test-worker-001"')
      );
    });
    
    test('should start heartbeat timer', () => {
      worker.startHeartbeat();
      
      expect(worker.heartbeatTimer).toBeDefined();
      expect(typeof worker.heartbeatTimer).toBe('object');
    });
  });

  describe('Result Storage', () => {
    test('should store result in Redis with TTL', async () => {
      const result = {
        username: 'test@example.com',
        password: 'password123',
        status: 'VALID',
        checkedAt: Date.now(),
        workerId: 'test-worker-001'
      };
      
      await worker.storeResult(result);
      
      expect(mockRedis.executeCommand).toHaveBeenCalledWith(
        'setex',
        'result:VALID:test@example.com:password123',
        2592000, // 30 days TTL
        JSON.stringify(result)
      );
    });
  });

  describe('Progress Tracking', () => {
    test('should increment progress counter for batch', async () => {
      await worker.incrementProgress('test-batch-001');
      
      expect(mockRedis.executeCommand).toHaveBeenCalledWith(
        'incr',
        'progress:test-batch-001:count'
      );
    });
  });

  describe('Graceful Shutdown', () => {
    test('should set shutdown flag and wait for current task', async () => {
      // Mock current task
      worker.currentTask = {
        taskId: 'test-task-001',
        batchId: 'test-batch'
      };
      
      // Mock cleanup
      jest.spyOn(worker, 'cleanup').mockResolvedValue();
      
      // Mock process.exit to prevent actual exit
      const mockExit = jest.spyOn(process, 'exit').mockImplementation();
      
      // Start shutdown (should complete quickly since we'll clear currentTask)
      const shutdownPromise = worker.handleShutdown('SIGTERM');
      
      // Clear current task to simulate completion
      setTimeout(() => {
        worker.currentTask = null;
      }, 100);
      
      await shutdownPromise;
      
      expect(worker.shutdown).toBe(true);
      expect(worker.cleanup).toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(0);
      
      mockExit.mockRestore();
    });
  });

  describe('Error Handling', () => {
    test('should identify fatal Redis errors', () => {
      const redisError = new Error('Connection is closed');
      expect(worker.isFatalError(redisError)).toBe(true);
      
      const normalError = new Error('HTTP timeout');
      expect(worker.isFatalError(normalError)).toBe(false);
    });
  });
});