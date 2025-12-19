/**
 * =============================================================================
 * HOTMAIL HANDLER - HOTMAIL (.jp Microsoft domains) batch processing
 * =============================================================================
 */

const { Markup } = require('telegraf');
const { createLogger } = require('../../../logger');
const {
  prepareBatchFromFile,
  ALLOWED_DOMAINS,
  MAX_BYTES_HOTMAIL,
} = require('../../../automation/batchProcessor');
const {
  escapeV2,
  buildProcessingHotmail,
  buildBatchParseFailed,
  buildNoEligible,
  buildAllProcessed,
  buildHotmailParsed,
  buildBatchFailed,
} = require('../../messages');
const { getPendingFile, deletePendingFile, setPendingBatch } = require('../batchState');
const { filterAlreadyProcessed } = require('../filterUtils');

const log = createLogger('batch-hotmail');

/**
 * Registers HOTMAIL batch type handler.
 * @param {Telegraf} bot - Telegraf bot instance
 */
function registerHotmailHandler(bot) {
  bot.action(/batch_type_hotmail_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const msgId = ctx.match[1];
    const key = `${ctx.chat.id}:${msgId}`;
    const file = getPendingFile(key);
    
    if (!file) {
      await ctx.reply(buildBatchFailed('File info expired. Send the file again.'), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: Number(msgId),
      });
      return;
    }

    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.update.callback_query.message.message_id,
        undefined,
        buildProcessingHotmail(),
        { parse_mode: 'MarkdownV2' }
      );
    } catch (_) {}

    let batch;
    try {
      batch = await prepareBatchFromFile(file.fileUrl, MAX_BYTES_HOTMAIL);
      log.info(`Parsed count=${batch.count} file=${file.filename}`);
    } catch (err) {
      await ctx.reply(buildBatchParseFailed(err.message), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: Number(msgId),
      });
      log.warn(`Parse failed file=${file.filename} msg=${err.message}`);
      return;
    }

    if (!batch.count) {
      await ctx.reply(buildNoEligible('Microsoft .jp'), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: Number(msgId),
      });
      return;
    }

    const { filtered, skipped } = await filterAlreadyProcessed(batch.creds);
    if (!filtered.length) {
      await ctx.reply(buildAllProcessed('in this file'), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: Number(msgId),
      });
      return;
    }

    batch.creds = filtered;
    batch.count = filtered.length;
    batch.skipped = skipped;

    deletePendingFile(key);
    setPendingBatch(key, {
      creds: batch.creds,
      filename: file.filename,
      count: batch.count,
      skipped: batch.skipped,
      sourceMessageId: Number(msgId),
    });

    await ctx.reply(
      buildHotmailParsed({ filename: file.filename, size: file.size, count: batch.count, allowedDomains: ALLOWED_DOMAINS }),
      {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: Number(msgId),
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Proceed', `batch_confirm_${msgId}`),
            Markup.button.callback('⛔ Cancel', `batch_cancel_${msgId}`),
          ],
        ]),
      }
    );
  });
}

module.exports = { registerHotmailHandler };

