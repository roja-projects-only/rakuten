/**
 * ProgressTracker Tests
 * 
 * Tests for the distributed worker architecture progress tracking component.
 */

const ProgressTracker = require('./ProgressTracker');
const { createStructuredLogger } = require('../logger/structured');

// Mock Redis client
const mockRedis = {
  setex: jest.fn(),
  set: jest.fn(),
  expire: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
  mget: jest.fn(),
  scan: jest.fn(),
  subscribe: jest.fn(),
  on: jest.fn()
};

// Mock Telegram client
const mockTelegram = {
  editMessageText: jest.fn(),
  sendMessage: jest.fn()
};

describe('ProgressTracker', () => {
  let progressTracker;
  
  beforeEach(() => {
    jest.clearAllMocks();
    progressTracker = new ProgressTracker(mockRedis, mockTelegram);
  });

  describe('initBatch', () => {
    it('should initialize batch progress tracking in Redis', async () => {
      const batchId = 'test-batch-123';
      const totalTasks = 100;
      const chatId = 12345;
      const messageId = 67890;

      await progressTracker.initBatch(batchId, totalTasks, chatId, messageId);

      // Verify Redis calls
      expect(mockRedis.setex).toHaveBeenCalledWith(
        `progress:${batchId}`,
        7 * 24 * 60 * 60, // 7 days TTL
        expect.stringContaining('"total":100')
      );
      
      expect(mockRedis.set).toHaveBeenCalledWith(`progress:${batchId}:count`, 0);
      expect(mockRedis.expire).toHaveBeenCalledWith(`progress:${batchId}:count`, 7 * 24 * 60 * 60);
      
      // Verify local cache
      expect(progressTracker.activeTrackers.has(batchId)).toBe(true);
      expect(progressTracker.updateTimers.has(batchId)).toBe(true);
    });
  });

  describe('getProgressData', () => {
    it('should return cached progress data', async () => {
      const batchId = 'test-batch-123';
      const progressData = {
        batchId,
        total: 100,
        completed: 50,
        chatId: 12345,
        messageId: 67890,
        startTime: Date.now()
      };
      
      progressTracker.activeTrackers.set(batchId, progressData);
      
      const result = await progressTracker.getProgressData(batchId);
      
      expect(result).toEqual(progressData);
      expect(mockRedis.get).not.toHaveBeenCalled(); // Should use cache
    });

    it('should fallback to Redis when not in cache', async () => {
      const batchId = 'test-batch-123';
      const progressData = {
        batchId,
        total: 100,
        completed: 50,
        chatId: 12345,
        messageId: 67890,
        startTime: Date.now()
      };
      
      mockRedis.get.mockResolvedValue(JSON.stringify(progressData));
      
      const result = await progressTracker.getProgressData(batchId);
      
      expect(mockRedis.get).toHaveBeenCalledWith(`progress:${batchId}`);
      expect(result).toEqual(progressData);
      expect(progressTracker.activeTrackers.has(batchId)).toBe(true); // Should cache
    });

    it('should return null for non-existent batch', async () => {
      const batchId = 'non-existent-batch';
      
      mockRedis.get.mockResolvedValue(null);
      
      const result = await progressTracker.getProgressData(batchId);
      
      expect(result).toBeNull();
    });
  });

  describe('handleProgressUpdate', () => {
    it('should throttle updates within 3 seconds', async () => {
      const batchId = 'test-batch-123';
      
      // Set last update time to 1 second ago
      progressTracker.updateTimers.set(batchId, Date.now() - 1000);
      
      await progressTracker.handleProgressUpdate(batchId);
      
      // Should not call Telegram API due to throttling
      expect(mockTelegram.editMessageText).not.toHaveBeenCalled();
    });

    it('should send update after throttle period', async () => {
      const batchId = 'test-batch-123';
      const progressData = {
        batchId,
        total: 100,
        completed: 50,
        chatId: 12345,
        messageId: 67890,
        startTime: Date.now() - 60000 // 1 minute ago
      };
      
      progressTracker.activeTrackers.set(batchId, progressData);
      progressTracker.updateTimers.set(batchId, Date.now() - 5000); // 5 seconds ago
      
      mockRedis.get.mockResolvedValue('75'); // 75 completed tasks
      
      await progressTracker.handleProgressUpdate(batchId);
      
      expect(mockRedis.get).toHaveBeenCalledWith(`progress:${batchId}:count`);
      expect(mockTelegram.editMessageText).toHaveBeenCalledWith(
        12345,
        67890,
        undefined,
        expect.stringContaining('75%'), // 75/100 = 75%
        { parse_mode: 'MarkdownV2' }
      );
    });
  });

  describe('cleanup', () => {
    it('should remove all progress tracking data', async () => {
      const batchId = 'test-batch-123';
      
      progressTracker.activeTrackers.set(batchId, {});
      progressTracker.updateTimers.set(batchId, Date.now());
      
      await progressTracker.cleanup(batchId);
      
      expect(mockRedis.del).toHaveBeenCalledWith(`progress:${batchId}`);
      expect(mockRedis.del).toHaveBeenCalledWith(`progress:${batchId}:count`);
      expect(progressTracker.activeTrackers.has(batchId)).toBe(false);
      expect(progressTracker.updateTimers.has(batchId)).toBe(false);
    });
  });
});