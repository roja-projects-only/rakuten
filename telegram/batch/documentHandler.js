/**
 * =============================================================================
 * DOCUMENT HANDLER - File upload handling
 * =============================================================================
 */

const { Markup } = require('telegraf');
const { createLogger } = require('../../logger');
const {
  escapeV2,
  formatBytes,
  buildFileTooLarge,
  buildFileReceived,
  buildUnableToLink,
  codeV2,
} = require('../messages');
const { hasSession: hasCombineSession, addFileToSession, getOrCreateSession } = require('../combineHandler');
const { setPendingFile } = require('./batchState');

const log = createLogger('batch-doc');

const TELEGRAM_FILE_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * Registers document (file upload) handler.
 * @param {Telegraf} bot - Telegraf bot instance
 */
function registerDocumentHandler(bot) {
  bot.on('document', async (ctx) => {
    const doc = ctx.message && ctx.message.document;
    if (!doc) return;

    const chatId = ctx.chat.id;
    const sourceMessageId = ctx.message && ctx.message.message_id;

    log.info(`File received name=${doc.file_name || 'unknown'} size=${doc.file_size || 0}`);

    if (doc.file_size && doc.file_size > TELEGRAM_FILE_LIMIT_BYTES) {
      await ctx.reply(buildFileTooLarge(), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: sourceMessageId,
      });
      return;
    }

    let fileUrl;
    try {
      const link = await ctx.telegram.getFileLink(doc.file_id);
      fileUrl = link.href || link.toString();
    } catch (err) {
      await ctx.reply(buildUnableToLink(err.message), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: doc.message_id,
      });
      return;
    }

    // Check if in combine mode - add file to session instead of normal flow
    if (hasCombineSession(chatId)) {
      const result = addFileToSession(chatId, {
        fileUrl,
        filename: doc.file_name || 'file.txt',
        size: doc.file_size,
      });
      
      if (!result.success) {
        await ctx.reply(escapeV2(`⚠️ ${result.error}`), {
          parse_mode: 'MarkdownV2',
          reply_to_message_id: sourceMessageId,
        });
        return;
      }
      
      const session = getOrCreateSession(chatId);
      const totalSize = session.files.reduce((sum, f) => sum + (f.size || 0), 0);
      
      log.info(`[combine] file added name=${doc.file_name} total_files=${session.files.length}`);
      
      // Just react with emoji to avoid spam
      try {
        await ctx.react('👍');
      } catch (_) {
        await ctx.reply(`📎 ${codeV2(String(session.files.length))} files \\(${escapeV2(formatBytes(totalSize))}\\)`, {
          parse_mode: 'MarkdownV2',
          reply_to_message_id: sourceMessageId,
        });
      }
      return;
    }

    const key = `${chatId}:${sourceMessageId}`;
    setPendingFile(key, {
      fileUrl,
      filename: doc.file_name || 'file.txt',
      size: doc.file_size,
      sourceMessageId,
    });

    await ctx.reply(buildFileReceived({ filename: doc.file_name || 'file', size: doc.file_size }), {
      parse_mode: 'MarkdownV2',
      reply_to_message_id: sourceMessageId,
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📧 HOTMAIL (.jp)', `batch_type_hotmail_${sourceMessageId}`),
          Markup.button.callback('📄 ULP (Rakuten)', `batch_type_ulp_${sourceMessageId}`),
        ],
        [
          Markup.button.callback('🇯🇵 JP Domains', `batch_type_jp_${sourceMessageId}`),
          Markup.button.callback('📋 ALL', `batch_type_all_${sourceMessageId}`),
        ],
        [Markup.button.callback('⛔ Cancel', `batch_cancel_${sourceMessageId}`)],
      ]),
    });
  });
}

module.exports = {
  registerDocumentHandler,
  TELEGRAM_FILE_LIMIT_BYTES,
};

