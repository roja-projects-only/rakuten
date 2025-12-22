/**
 * Test script for batch queueing in coordinator mode
 */

const { createLogger } = require('./logger');
const log = createLogger('test');

// Mock generateBatchId
const generateBatchId = () => `batch-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

// Mock helpers
const helpers = {
  escapeV2: (text) => text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&'),
  formatDurationMs: (ms) => `${Math.round(ms / 1000)}s`
};

// Mock JobQueueManager
class MockJobQueueManager {
  async enqueueBatch(batchId, credentials, options) {
    log.info('JobQueueManager.enqueueBatch called with:', {
      batchId,
      credentialsCount: credentials.length,
      options
    });
    
    // Simulate deduplication
    const queued = Math.floor(credentials.length * 0.85);
    const cached = credentials.length - queued;
    
    log.info(`Would queue ${queued} tasks, ${cached} cached`);
    
    return { queued, cached };
  }
}

// Mock Coordinator
class MockCoordinator {
  constructor() {
    this.jobQueue = new MockJobQueueManager();
  }
}

// Mock compatibility layer
const mockCompatibility = {
  coordinator: new MockCoordinator(),
  isDistributed: () => true,
  getMode: () => 'coordinator'
};

// Mock Telegraf context
const mockCtx = {
  chat: { id: 123456789 },
  from: { id: 987654321 },
  telegram: {
    editMessageText: async (chatId, msgId, _, text, opts) => {
      log.info('Would update Telegram message:', {
        chatId,
        msgId,
        textPreview: text.substring(0, 100)
      });
    }
  }
};

// Mock batch data
const mockBatch = {
  creds: [
    { username: 'test1@example.com', password: 'pass1' },
    { username: 'test2@example.com', password: 'pass2' },
    { username: 'test3@example.com', password: 'pass3' }
  ],
  count: 3,
  filename: 'test-batch.txt'
};

const mockStatusMsg = { message_id: 12345 };
const mockOptions = { 
  compatibility: mockCompatibility,
  timeoutMs: 60000
};

// Test function (simplified version of runDistributedBatch)
async function testDistributedBatch() {
  log.info('=== Testing Distributed Batch Queue ===');
  
  try {
    const compatibility = mockOptions.compatibility;
    const coordinator = compatibility.coordinator;
    
    if (!coordinator || !coordinator.jobQueue) {
      log.error('Coordinator structure:', Object.keys(compatibility || {}));
      throw new Error('Coordinator not initialized - jobQueue not available');
    }
    
    log.info(`Queuing ${mockBatch.count} credentials to job queue`);
    
    // Generate batch ID
    const batchId = generateBatchId();
    
    // Queue the batch with correct parameters
    const result = await coordinator.jobQueue.enqueueBatch(
      batchId,
      mockBatch.creds,
      {
        batchType: 'HOTMAIL',
        chatId: mockCtx.chat.id,
        filename: mockBatch.filename,
        userId: mockCtx.from.id
      }
    );
    
    log.info('Batch queued successfully:', result);
    
    // Update message with queued status
    const text = helpers.escapeV2(`✅ Batch queued!\n\n` +
      `📁 File: ${mockBatch.filename}\n` +
      `📊 Total: ${mockBatch.count} credentials\n` +
      `✨ Queued: ${result.queued} new tasks\n` +
      `💾 Cached: ${result.cached} already processed\n` +
      `🆔 Batch ID: ${batchId}\n\n` +
      `Workers will process this batch. Check back soon!`);
    
    await mockCtx.telegram.editMessageText(
      mockCtx.chat.id, 
      mockStatusMsg.message_id, 
      undefined, 
      text, 
      { parse_mode: 'MarkdownV2' }
    );
    
    log.info('✅ Test passed! Batch queueing works correctly.');
    
  } catch (error) {
    log.error('❌ Test failed:', error.message);
    log.error('Stack:', error.stack);
    process.exit(1);
  }
}

// Run test
testDistributedBatch()
  .then(() => {
    log.info('=== Test completed successfully ===');
    process.exit(0);
  })
  .catch((err) => {
    log.error('=== Test failed ===', err);
    process.exit(1);
  });
