/**
 * Status Command Handler for Distributed Worker Architecture
 * 
 * Provides /status command to display system health and statistics.
 * Integrates with the Coordinator class to get real-time system status.
 * 
 * Requirements: 8.2, 8.3, 8.6
 */

const { createLogger } = require('../shared/logger');
const { escapeV2 } = require('./messages/helpers');

const log = createLogger('status-handler');

/**
 * Register /status command handler with the Telegram bot
 * @param {Telegraf} bot - Telegram bot instance
 * @param {Coordinator} coordinator - Coordinator instance (required)
 */
function registerStatusHandler(bot, coordinator) {
  bot.command('status', async (ctx) => {
    try {
      const chatId = ctx.chat.id;
      
      // Coordinator is required for status
      if (!coordinator) {
        await ctx.reply(escapeV2('⚠️ Status command requires a coordinator instance'), { parse_mode: 'MarkdownV2' });
        return;
      }
      
      // Check if coordinator is running
      if (!coordinator.isRunning) {
        await ctx.reply(escapeV2('⚠️ Coordinator is not running'), { parse_mode: 'MarkdownV2' });
        return;
      }
      
      // Send "loading" message
      const loadingMsg = await ctx.reply(escapeV2('📊 Gathering system status...'), { parse_mode: 'MarkdownV2' });
      
      try {
        // Get system status from coordinator
        const status = await coordinator.getSystemStatus();
        
        // Format status message
        const statusMessage = coordinator.formatSystemStatus(status);
        
        // Edit the loading message with actual status
        await ctx.telegram.editMessageText(
          chatId,
          loadingMsg.message_id,
          null,
          statusMessage,
          { parse_mode: 'MarkdownV2' }
        );
        
        log.info('Status command executed', {
          chatId,
          activeWorkers: status.workers.active,
          queueDepth: status.queue.total,
          healthyProxies: status.proxies.healthy
        });
        
      } catch (statusError) {
        log.error('Failed to get system status', {
          chatId,
          error: statusError.message
        });
        
        // Edit loading message with error
        await ctx.telegram.editMessageText(
          chatId,
          loadingMsg.message_id,
          null,
          escapeV2('❌ Failed to get system status: ' + statusError.message),
          { parse_mode: 'MarkdownV2' }
        );
      }
      
    } catch (error) {
      log.error('Status command error', {
        chatId: ctx.chat?.id,
        error: error.message
      });
      
      await ctx.reply(
        escapeV2('❌ Error executing status command: ' + error.message),
        { parse_mode: 'MarkdownV2' }
      );
    }
  });
  
  log.info('Status command handler registered');
}

module.exports = {
  registerStatusHandler
};
