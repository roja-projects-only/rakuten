/**
 * =============================================================================
 * ALL HANDLER - ALL mode batch processing (no domain filter)
 * =============================================================================
 */

const { Markup } = require('telegraf');
const { createLogger } = require('../../../shared/logger');
const {
  prepareAllBatch,
  MAX_BYTES_HOTMAIL,
} = require('../../../shared/batch/processor');
const {
  escapeV2,
  codeSpan,
  buildBatchParseFailed,
  buildAllProcessed,
  buildBatchFailed,
} = require('../../messages');
const { getPendingFile, deletePendingFile, setPendingBatch } = require('../batchState');
const { filterAlreadyProcessed } = require('../filterUtils');

const log = createLogger('batch-all');

/**
 * Registers ALL mode batch type handler (no domain filtering).
 * @param {Telegraf} bot - Telegraf bot instance
 */
function registerAllHandler(bot) {
  bot.action(/batch_type_all_(.+)/, async (ctx) => {
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
        escapeV2('⏳ Parsing all credentials (no filter)...'),
        { parse_mode: 'MarkdownV2' }
      );
    } catch (_) {}

    let batch;
    try {
      batch = await prepareAllBatch(file.fileUrl, MAX_BYTES_HOTMAIL);
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
      await ctx.reply(escapeV2('⚠️ No valid credentials found in file.'), {
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

    const msg = escapeV2(`📋 ALL Mode (no filter)\n`) +
      escapeV2(`📄 File: `) + codeSpan(file.filename) + escapeV2(`\n`) +
      escapeV2(`📊 Found: ${batch.count} credentials\n`) +
      (batch.skipped ? escapeV2(`⏭️ Skipped: ${batch.skipped} (already processed)\n`) : '') +
      escapeV2(`\nReady to process?`);

    await ctx.reply(msg, {
      parse_mode: 'MarkdownV2',
      reply_to_message_id: Number(msgId),
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Proceed', `batch_confirm_${msgId}`),
          Markup.button.callback('⛔ Cancel', `batch_cancel_${msgId}`),
        ],
      ]),
    });
  });
}

module.exports = { registerAllHandler };
