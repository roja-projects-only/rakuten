/**
 * =============================================================================
 * BATCH MESSAGES - Batch processing related messages
 * =============================================================================
 */

const { escapeV2, codeV2, boldV2, spoilerCodeV2, formatBytes, formatDurationMs, codeSpan } = require('./helpers');

/**
 * Builds file too large message.
 * @returns {string} Message
 */
function buildFileTooLarge() {
  return escapeV2('⚠️ File too large for Telegram bot download (max ~20MB). For bigger lists, host the file and use `.ulp <url>` instead.');
}

/**
 * Builds file received message.
 * @param {Object} data - File data
 * @returns {string} Message
 */
function buildFileReceived({ filename, size }) {
  return (
    '📂 ' + boldV2('File received') +
    `\n• Name: ${codeSpan(filename || 'file')}` +
    `\n• Size: ${escapeV2(formatBytes(size))}` +
    '\n\n' + escapeV2('Choose processing type:') +
    `\n• ${escapeV2('HOTMAIL (.jp Microsoft)')}` +
    `\n• ${escapeV2('ULP (Rakuten filter)')}`
  );
}

/**
 * Builds unable to link message.
 * @param {string} err - Error message
 * @returns {string} Message
 */
function buildUnableToLink(err) {
  return `⚠️ Unable to get file link: ${escapeV2(err)}`;
}

/**
 * Builds ULP processing message.
 * @returns {string} Message
 */
function buildUlpProcessing() {
  return escapeV2('⏳ Processing ULP URL (this may take a while)...');
}

/**
 * Builds ULP parsed message.
 * @param {Object} data - Parse data
 * @returns {string} Message
 */
function buildUlpParsed({ url, count }) {
  const trimmed = url.length > 120 ? `${url.slice(0, 117)}...` : url;
  return (
    '🗂 ' + boldV2('ULP URL parsed') +
    `\n• Source: ${codeSpan(trimmed)}` +
    `\n• Eligible credentials: *${escapeV2(String(count))}*` +
    '\n• Filter: ' + codeSpan('rakuten.co.jp') + ' ' + escapeV2('(deduped)') +
    '\n\nProceed to check them?'
  );
}

/**
 * Builds ULP file parsed message.
 * @param {Object} data - File data
 * @returns {string} Message
 */
function buildUlpFileParsed({ filename, size, count }) {
  return (
    '📂 ' + boldV2('ULP file parsed') +
    `\n• Name: ${codeSpan(filename)}` +
    `\n• Size: ${escapeV2(formatBytes(size))}` +
    `\n• Eligible credentials: *${escapeV2(String(count))}*` +
    '\n• Filter: ' + codeSpan('rakuten.co.jp') + ' ' + escapeV2('(deduped)') +
    '\n\nProceed to check them?'
  );
}

/**
 * Builds HOTMAIL parsed message.
 * @param {Object} data - Parse data
 * @returns {string} Message
 */
function buildHotmailParsed({ filename, size, count, allowedDomains }) {
  return (
    '📂 ' + boldV2('HOTMAIL list parsed') +
    `\n• Name: ${codeSpan(filename)}` +
    `\n• Size: ${escapeV2(formatBytes(size))}` +
    `\n• Eligible credentials: *${escapeV2(String(count))}*` +
    '\n• Allowed domains: ' + allowedDomains.map(codeSpan).join(', ') +
    '\n\nProceed to check them?'
  );
}

/**
 * Builds no eligible message.
 * @param {string} contextText - Context description
 * @returns {string} Message
 */
function buildNoEligible(contextText) {
  return escapeV2(`ℹ️ No eligible ${contextText} credentials found.`);
}

/**
 * Builds all processed message.
 * @param {string} contextText - Context description
 * @returns {string} Message
 */
function buildAllProcessed(contextText) {
  return escapeV2(`ℹ️ All eligible credentials ${contextText} were processed in the last 24h.`);
}

/**
 * Builds batch parse failed message.
 * @param {string} message - Error message
 * @returns {string} Message
 */
function buildBatchParseFailed(message) {
  return `⚠️ Failed to read: ${escapeV2(message)}`;
}

/**
 * Builds batch confirm start message.
 * @param {Object} data - Batch data
 * @returns {string} Message
 */
function buildBatchConfirmStart({ filename, count, skipped }) {
  return (
    escapeV2('⏳ Starting batch check') +
    `\nFile: ${codeSpan(filename)}` +
    `\nEntries: *${escapeV2(String(count))}*` +
    `\n${escapeV2('Skipped (24h)')}: *${escapeV2(String(skipped || 0))}*`
  );
}

/**
 * Builds batch progress message.
 * @param {Object} data - Progress data
 * @returns {string} Message
 */
function buildBatchProgress({ filename, processed, total, counts, validCreds = [] }) {
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  const bar = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
  
  const parts = [];
  parts.push(`⏳ ${boldV2('Processing...')}`);
  parts.push('');
  parts.push(`${escapeV2(bar)} ${codeV2(`${pct}%`)}`);
  parts.push(`${codeV2(`${processed}/${total}`)} credentials`);
  parts.push('');
  parts.push(`✅ ${codeV2(String(counts.VALID || 0))} ❌ ${codeV2(String(counts.INVALID || 0))} 🔒 ${codeV2(String(counts.BLOCKED || 0))} ⚠️ ${codeV2(String(counts.ERROR || 0))}`);
  
  if (validCreds && validCreds.length > 0) {
    parts.push('');
    parts.push(boldV2('💎 Valid Found:'));
    // Show only the latest 10 credentials (tail of array)
    const displayCreds = validCreds.slice(-10);
    displayCreds.forEach((cred) => {
      parts.push(`• ${codeV2(`${cred.username}:${cred.password}`)}`);
    });
    if (validCreds.length > 10) {
      parts.push(`• ${boldV2(`...and ${validCreds.length - 10} more`)}`);
    }
  }
  
  return parts.join('\n');
}

/**
 * Builds batch summary message.
 * @param {Object} data - Summary data
 * @returns {string} Message
 */
function buildBatchSummary({ filename, total, skipped, counts, elapsedMs, validCreds }) {
  const parts = [];
  
  parts.push(`📊 ${boldV2('BATCH COMPLETE')}`);
  parts.push('');
  
  parts.push(boldV2('📈 Statistics'));
  parts.push(`├ File: ${codeSpan(filename)}`);
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
      parts.push(`${prefix} ${codeV2(`${cred.username}:${cred.password}`)}`);
    });
  }

  return parts.join('\n');
}

/**
 * Builds batch aborted message (full summary with ABORTED footer).
 * @param {Object} data - Abort data (same as summary)
 * @returns {string} Message
 */
function buildBatchAborted({ filename, total, skipped, counts, elapsedMs, validCreds, processed }) {
  const parts = [];
  
  parts.push(`📊 ${boldV2('BATCH ABORTED')}`);  parts.push('');
  
  parts.push(boldV2('📈 Statistics'));
  parts.push(`├ File: ${codeSpan(filename)}`);
  parts.push(`├ Total: ${codeV2(String(total))}`);
  parts.push(`├ Processed: ${codeV2(String(processed || 0))}`);
  if (skipped) {
    parts.push(`├ Skipped: ${codeV2(String(skipped))}`);
  }
  parts.push(`└ Time: ${codeV2(formatDurationMs(elapsedMs || 0))}`);
  parts.push('');
  
  parts.push(boldV2('📋 Results'));
  parts.push(`├ ✅ Valid: ${codeV2(String(counts?.VALID || 0))}`);
  parts.push(`├ ❌ Invalid: ${codeV2(String(counts?.INVALID || 0))}`);
  parts.push(`├ 🔒 Blocked: ${codeV2(String(counts?.BLOCKED || 0))}`);
  parts.push(`└ ⚠️ Error: ${codeV2(String(counts?.ERROR || 0))}`);
  
  if (validCreds && validCreds.length > 0) {
    parts.push('');
    parts.push(boldV2('🔐 Valid Credentials'));
    validCreds.forEach((cred, i) => {
      const prefix = i === validCreds.length - 1 ? '└' : '├';
      parts.push(`${prefix} ${codeV2(`${cred.username}:${cred.password}`)}`);
    });
  }
  
  parts.push('');
  parts.push(`⏹️ ${escapeV2('Batch stopped by user')}`);

  return parts.join('\n');
}

/**
 * Builds batch cancelled message.
 * @returns {string} Message
 */
function buildBatchCancelled() {
  return escapeV2('❎ Batch cancelled. Send a new file to try again.');
}

/**
 * Builds batch aborting message.
 * @returns {string} Message
 */
function buildBatchAborting() {
  return escapeV2('⏹ Aborting batch, please wait...');
}

/**
 * Builds no active batch message.
 * @returns {string} Message
 */
function buildNoActiveBatch() {
  return escapeV2('⚠️ No active batch to abort.');
}

/**
 * Builds batch failed message.
 * @param {string} message - Error message
 * @returns {string} Message
 */
function buildBatchFailed(message) {
  return escapeV2(`⚠️ Batch failed: ${message}`);
}

/**
 * Builds processing hotmail message.
 * @returns {string} Message
 */
function buildProcessingHotmail() {
  return escapeV2('⏳ Processing HOTMAIL file...');
}

/**
 * Builds processing ULP message.
 * @returns {string} Message
 */
function buildProcessingUlp() {
  return escapeV2('⏳ Processing ULP file...');
}

module.exports = {
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
  buildProcessingUlp,
};

