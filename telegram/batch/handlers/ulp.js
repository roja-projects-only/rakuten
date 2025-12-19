/**
 * =============================================================================
 * ULP HANDLER - ULP (Rakuten) batch processing
 * =============================================================================
 */

const { Markup } = require('telegraf');
const { createLogger } = require('../../../logger');
const {
  prepareUlpBatch,
  MAX_BYTES_ULP,
} = require('../../../automation/batchProcessor');
const {
  escapeV2,
  buildUlpProcessing,
  buildUlpFileParsed,
  buildUlpParsed,
  buildBatchParseFailed,
  buildNoEligible,
  buildAllProcessed,
  buildBatchFailed,
  buildProcessingUlp,
} = require('../../messages');
const { getPendingFile, deletePendingFile, setPendingBatch } = require('../batchState');
const { filterAlreadyProcessed } = require('../filterUtils');

const log = createLogger('batch-ulp');

/**
 * Registers ULP batch type handlers (file and URL).
 * @param {Telegraf} bot - Telegraf bot instance
 */
function registerUlpHandler(bot) {
  // ULP file handler
  bot.action(/batch_type_ulp_(.+)/, async (ctx) => {
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
        buildProcessingUlp(),
        { parse_mode: 'MarkdownV2' }
      );
    } catch (_) {}

    let batch;
    try {
      batch = await prepareUlpBatch(file.fileUrl, MAX_BYTES_ULP);
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
      await ctx.reply(buildNoEligible('Rakuten'), {
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
      buildUlpFileParsed({ filename: file.filename, size: file.size, count: batch.count }),
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

  // ULP URL handler (.ulp command)
  bot.hears(/^\.ulp\s+(https?:\/\/\S+)/i, async (ctx) => {
    const chatId = ctx.chat.id;
    const sourceMessageId = ctx.message && ctx.message.message_id;
    const url = ctx.match[1];

    log.info(`Start url=${url}`);

    if (!url || url.length > 1000) {
      await ctx.reply(escapeV2('⚠️ Provide a valid URL after `.ulp`.'), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: sourceMessageId,
      });
      return;
    }

    try {
      await ctx.reply(buildUlpProcessing(), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: sourceMessageId,
      });
    } catch (_) {}

    let batch;
    try {
      batch = await prepareUlpBatch(url, MAX_BYTES_ULP);
      log.info(`Parsed count=${batch.count}`);
    } catch (err) {
      await ctx.reply(buildBatchParseFailed(err.message), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: sourceMessageId,
      });
      log.warn(`Parse failed url=${url} msg=${err.message}`);
      return;
    }

    if (!batch.count) {
      await ctx.reply(buildNoEligible('Rakuten'), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: sourceMessageId,
      });
      return;
    }

    const { filtered, skipped } = await filterAlreadyProcessed(batch.creds);
    if (!filtered.length) {
      await ctx.reply(buildAllProcessed('from this URL'), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: sourceMessageId,
      });
      return;
    }

    batch.creds = filtered;
    batch.count = filtered.length;
    batch.skipped = skipped;

    const key = `${chatId}:${sourceMessageId}`;
    setPendingBatch(key, {
      creds: batch.creds,
      filename: url,
      count: batch.count,
      skipped: batch.skipped,
      sourceMessageId: Number(sourceMessageId),
    });

    await ctx.reply(buildUlpParsed({ url, count: batch.count }), {
      parse_mode: 'MarkdownV2',
      reply_to_message_id: sourceMessageId,
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Proceed', `batch_confirm_${sourceMessageId}`),
          Markup.button.callback('⛔ Cancel', `batch_cancel_${sourceMessageId}`),
        ],
      ]),
    });
  });
}

module.exports = { registerUlpHandler };

