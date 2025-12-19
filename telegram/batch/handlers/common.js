/**
 * =============================================================================
 * COMMON HANDLERS - Shared batch action handlers
 * =============================================================================
 * 
 * Handlers for confirm, cancel, and abort actions that work across all batch types.
 * 
 * =============================================================================
 */

const { Markup } = require('telegraf');
const { createLogger } = require('../../../logger');
const {
  buildBatchConfirmStart,
  buildBatchCancelled,
  buildBatchAborting,
  buildNoActiveBatch,
  buildBatchFailed,
} = require('../../messages');
const { getPendingBatch, deletePendingBatch, deletePendingFile } = require('../batchState');
const { runBatchExecution } = require('../batchExecutor');

const log = createLogger('batch-common');

/**
 * Registers common batch handlers (confirm, cancel, abort).
 * @param {Telegraf} bot - Telegraf bot instance
 * @param {Object} options - Options including checkCredentials function
 * @param {Object} helpers - Helper functions
 */
function registerCommonHandlers(bot, options, helpers) {
  const checkCredentials = options.checkCredentials;

  // Confirm batch start
  bot.action(/batch_confirm_(.+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const msgId = ctx.match[1];
      const key = `${ctx.chat.id}:${msgId}`;
      const batch = getPendingBatch(key);
      
      if (!batch) {
        await ctx.reply(buildBatchFailed('Batch expired. Send the file again to restart.'), {
          parse_mode: 'MarkdownV2',
          reply_to_message_id: Number(msgId),
        });
        return;
      }

      const statusText = buildBatchConfirmStart({
        filename: batch.filename,
        count: batch.count,
        skipped: batch.skipped,
      });

      const statusMsg = await ctx.reply(statusText, {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: Number(msgId),
        ...Markup.inlineKeyboard([[Markup.button.callback('⏹ Abort', `batch_abort_${msgId}`)]]),
      });

      log.info(`Starting file=${batch.filename} count=${batch.count}`);

      runBatchExecution(ctx, batch, msgId, statusMsg, options, helpers, key, checkCredentials);
    } catch (err) {
      log.warn('Batch confirm handler error:', err.message);
      await ctx.reply(buildBatchFailed(err.message), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: ctx.update?.callback_query?.message?.message_id,
      });
    }
  });

  // Cancel batch before starting
  bot.action(/batch_cancel_(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Batch cancelled');
    const msgId = ctx.match[1];
    const key = `${ctx.chat.id}:${msgId}`;
    deletePendingBatch(key);
    deletePendingFile(key);
    
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.update.callback_query.message.message_id,
        undefined,
        buildBatchCancelled(),
        { parse_mode: 'MarkdownV2' }
      );
    } catch (_) {
      await ctx.reply(buildBatchCancelled(), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: Number(msgId),
      });
    }
  });

  // Abort running batch
  bot.action(/batch_abort_(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Aborting...');
    const msgId = ctx.match[1];
    const key = `${ctx.chat.id}:${msgId}`;
    const batch = getPendingBatch(key);
    
    if (batch) {
      batch.aborted = true;
      log.info(`Abort requested file=${batch.filename}`);
      
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.update.callback_query.message.message_id,
          undefined,
          buildBatchAborting(),
          {
            parse_mode: 'MarkdownV2',
            ...Markup.inlineKeyboard([]),
          }
        );
      } catch (_) {}
      
      // Wait for batch to finish
      if (batch._completionPromise) {
        await batch._completionPromise;
      }
    } else {
      await ctx.reply(buildNoActiveBatch(), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: ctx.update.callback_query.message.message_id,
      });
    }
  });
}

module.exports = { registerCommonHandlers };

