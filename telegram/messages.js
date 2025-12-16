const { Markup } = require('telegraf');

// MarkdownV2 escapers/helpers
function escapeV2(text = '') {
  return String(text).replace(/[\\_*\[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function codeV2(text = '') {
  // For code spans in MarkdownV2, only backticks and backslashes need escaping.
  const safe = String(text).replace(/[`\\]/g, '\\$&');
  return `\`${safe}\``;
}

function boldV2(text = '') {
  return `*${escapeV2(text)}*`;
}

function spoilerV2(text = '') {
  return `||${escapeV2(text)}||`;
}

function spoilerCodeV2(text = '') {
  const safe = String(text).replace(/[`\\]/g, '\\$&');
  return `||\`${safe}\`||`;
}

function maskEmail(email = '') {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const name = email.slice(0, at);
  if (name.length < 3) return '***';
  return `${name.slice(0, 3)}***${name.slice(-2)}`;
}

function formatBytes(bytes) {
  if (!bytes || Number.isNaN(bytes)) return 'unknown';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

function formatDurationMs(ms) {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = (seconds % 60).toFixed(1);
  return `${minutes}m ${rem}s`;
}

// Static texts
function buildStartMessage() {
  return (
    '🎌 ' + boldV2('Rakuten Credential Checker') +
    '\n\n' + '⚡ High\\-speed HTTP\\-based validation' +
    '\n\n' + '📖 ' + boldV2('Usage:') +
    '\n' + codeV2('.chk email:password') +
    '\n\n' + '🧭 ' + boldV2('Example:') +
    '\n' + codeV2('.chk user@rakuten.co.jp:mypass123') +
    '\n\n' + '✨ ' + boldV2('Features:') +
    '\n• Real\\-time status updates' +
    '\n• Auto\\-capture points \\& rank' +
    '\n• Batch file processing' +
    '\n• Credential masking'
  );
}

function buildHelpMessage() {
  return (
    '❓ ' + boldV2('Help & Commands') +
    '\n\n' + boldV2('Single Check:') +
    '\n' + codeV2('.chk email:password') +
    '\n\n' + boldV2('Status Codes:') +
    '\n✅ ' + codeV2('VALID') + ' — Login successful' +
    '\n❌ ' + codeV2('INVALID') + ' — Wrong credentials' +
    '\n🔒 ' + codeV2('BLOCKED') + ' — Account locked' +
    '\n⚠️ ' + codeV2('ERROR') + ' — Technical issue' +
    '\n\n' + boldV2('Batch Processing:') +
    '\n• Upload ' + codeV2('.txt') + ' file with credentials' +
    '\n• One per line: ' + codeV2('email:password')
  );
}

function buildGuideMessage() {
  return (
    '📚 ' + boldV2('Quick Guide') +
    '\n1) Type ' + codeV2('.chk email:password') +
    '\n2) Wait for the check' +
    '\n3) Review the result' +
    '\n4) Capture data if valid'
  );
}

// .chk flow
function buildGuardError(message) {
  return `❌ ${escapeV2(message)}`;
}

function buildCheckQueued() {
  return '⏳ ' + escapeV2('Checking credentials...');
}

function buildCheckProgress(phase) {
  const map = {
    launch: '⏳ Initializing...',
    navigate: '🌐 Connecting to Rakuten...',
    email: '✉️ Verifying account...',
    password: '🔑 Authenticating...',
    analyze: '🔍 Analyzing response...',
    capture: '📊 Capturing data...',
  };
  return escapeV2(map[phase] || '⏳ Processing...');
}

function buildCheckResult(result, username = null, durationMs = null, password = null) {
  const statusEmoji = { VALID: '✅', INVALID: '❌', BLOCKED: '🔒', ERROR: '⚠️' };
  const statusLabel = {
    VALID: 'LOGIN SUCCESSFUL',
    INVALID: 'LOGIN FAILED',
    BLOCKED: 'ACCOUNT BLOCKED',
    ERROR: 'CHECK FAILED',
  };

  const emoji = statusEmoji[result.status] || '❓';
  const label = statusLabel[result.status] || result.status || 'UNKNOWN';

  const parts = [];
  
  // Header
  parts.push(`${emoji} ${boldV2(label)}`);
  parts.push('');
  
  // Credentials section
  parts.push(boldV2('🔐 Credentials'));
  if (username) {
    parts.push(`├ User: ${codeV2(username)}`);
  }
  if (password) {
    parts.push(`└ Pass: ${spoilerCodeV2(password)}`);
  } else if (username) {
    parts.push(`└ Pass: ${codeV2('••••••••')}`);
  }

  // Time
  if (durationMs != null) {
    parts.push('');
    const seconds = durationMs / 1000;
    const pretty = seconds >= 10 ? seconds.toFixed(1) : seconds.toFixed(2);
    parts.push(`⏱ ${codeV2(`${pretty}s`)}`);
  }

  return parts.join('\n');
}

/**
 * Build unified check + capture result message
 * @param {Object} result - Check result
 * @param {Object} capture - Captured account data
 * @param {string} username - Username/email
 * @param {number} durationMs - Duration in milliseconds
 * @param {string} password - Password (optional, for display)
 */
function buildCheckAndCaptureResult(result, capture, username, durationMs, password = null) {
  const statusEmoji = { VALID: '✅', INVALID: '❌', BLOCKED: '🔒', ERROR: '⚠️' };
  const statusLabel = {
    VALID: 'LOGIN SUCCESSFUL',
    INVALID: 'LOGIN FAILED',
    BLOCKED: 'ACCOUNT BLOCKED',
    ERROR: 'CHECK FAILED',
  };
  
  const emoji = statusEmoji[result.status] || '❓';
  const label = statusLabel[result.status] || result.status;
  
  const parts = [];
  
  // Header
  parts.push(`${emoji} ${boldV2(label)}`);
  parts.push('');
  
  // Account Data section (for valid)
  if (result.status === 'VALID' && capture) {
    parts.push(boldV2('📊 Account Data'));
    parts.push(`├ Points: ${codeV2(capture.points || '0')}`);
    parts.push(`├ Cash: ${codeV2(capture.cash || '0')}`);
    parts.push(`└ Rank: ${codeV2(capture.rank || 'n/a')}`);
    parts.push('');
  }
  
  // Credentials section
  parts.push(boldV2('🔐 Credentials'));
  if (username) {
    parts.push(`├ User: ${codeV2(username)}`);
  }
  if (password) {
    parts.push(`└ Pass: ${spoilerCodeV2(password)}`);
  } else if (username) {
    parts.push(`└ Pass: ${codeV2('••••••••')}`);
  }
  
  // Time
  if (durationMs != null) {
    parts.push('');
    const seconds = durationMs / 1000;
    const pretty = seconds >= 10 ? seconds.toFixed(1) : seconds.toFixed(2);
    parts.push(`⏱ ${codeV2(`${pretty}s`)}`);
  }

  return parts.join('\n');
}

function buildCheckError(message) {
  return (
    '⚠️ ' + boldV2('CHECK FAILED') +
    '\n\n' + escapeV2(message) +
    '\n\n' + italicV2('Please try again')
  );
}

function italicV2(text = '') {
  return `_${escapeV2(text)}_`;
}

// Capture
function buildCapturePrompt() {
  return escapeV2('🔍 Proceed to capture data?');
}

function buildCaptureExpired() {
  return escapeV2('⌛ Capture session expired. Send `.chk email:password` again to restart.');
}

function buildCaptureSummary({ points, cash, username, password }) {
  return (
    escapeV2('🗂️ Capture Summary') +
    `\n• ${boldV2('Points')}: ${escapeV2(points || 'n/a')}` +
    `\n• ${boldV2('Rakuten Cash')}: ${escapeV2(cash || 'n/a')}` +
    `\n• Username: ${spoilerCodeV2(username || 'unknown')}` +
    `\n• Password: ${spoilerCodeV2(password || 'hidden')}`
  );
}

function buildCaptureFailed(message) {
  return `⚠️ Capture failed: ${escapeV2(message)}`;
}

function buildCaptureSkipped() {
  return escapeV2('❎ Data capture skipped. Send `.chk` again if you want to restart.');
}

// Batch flows
function codeSpan(text) {
  return codeV2(text ?? '');
}

function buildFileTooLarge() {
  return escapeV2('⚠️ File too large for Telegram bot download (max ~20MB). For bigger lists, host the file and use `.ulp <url>` instead.');
}

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

function buildUnableToLink(err) {
  return `⚠️ Unable to get file link: ${escapeV2(err)}`;
}

function buildUlpProcessing() {
  return escapeV2('⏳ Processing ULP URL (this may take a while)...');
}

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

function buildNoEligible(contextText) {
  return escapeV2(`ℹ️ No eligible ${contextText} credentials found.`);
}

function buildAllProcessed(contextText) {
  return escapeV2(`ℹ️ All eligible credentials ${contextText} were processed in the last 24h.`);
}

function buildBatchParseFailed(message) {
  return `⚠️ Failed to read: ${escapeV2(message)}`;
}

function buildBatchConfirmStart({ filename, count, skipped }) {
  return (
    escapeV2('⏳ Starting batch check') +
    `\nFile: ${codeSpan(filename)}` +
    `\nEntries: *${escapeV2(String(count))}*` +
    `\n${escapeV2('Skipped (24h)')}: *${escapeV2(String(skipped || 0))}*`
  );
}

function buildBatchProgress({ filename, processed, total, counts }) {
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  const bar = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
  
  const parts = [];
  parts.push(`⏳ ${boldV2('Processing...')}`);
  parts.push('');
  parts.push(`${escapeV2(bar)} ${codeV2(`${pct}%`)}`);
  parts.push(`${codeV2(`${processed}/${total}`)} credentials`);
  parts.push('');
  parts.push(`✅ ${codeV2(String(counts.VALID || 0))} ❌ ${codeV2(String(counts.INVALID || 0))} 🔒 ${codeV2(String(counts.BLOCKED || 0))} ⚠️ ${codeV2(String(counts.ERROR || 0))}`);
  
  return parts.join('\n');
}

function buildBatchSummary({ filename, total, skipped, counts, elapsedMs, validCreds }) {
  const parts = [];
  
  // Header
  parts.push(`📊 ${boldV2('BATCH COMPLETE')}`);
  parts.push('');
  
  // Stats
  parts.push(boldV2('📈 Statistics'));
  parts.push(`├ File: ${codeSpan(filename)}`);
  parts.push(`├ Total: ${codeV2(String(total))}`);
  if (skipped) {
    parts.push(`├ Skipped: ${codeV2(String(skipped))}`);
  }
  parts.push(`└ Time: ${codeV2(formatDurationMs(elapsedMs))}`);
  parts.push('');
  
  // Results breakdown
  parts.push(boldV2('📋 Results'));
  parts.push(`├ ✅ Valid: ${codeV2(String(counts.VALID || 0))}`);
  parts.push(`├ ❌ Invalid: ${codeV2(String(counts.INVALID || 0))}`);
  parts.push(`├ 🔒 Blocked: ${codeV2(String(counts.BLOCKED || 0))}`);
  parts.push(`└ ⚠️ Error: ${codeV2(String(counts.ERROR || 0))}`);
  
  // Valid credentials
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

function buildBatchAborted({ filename, total, processed }) {
  return (
    escapeV2('⏹️ Batch aborted') +
    `\nFile: ${codeSpan(filename)}` +
    `\nProcessed: *${processed}/${total}*`
  );
}

function buildBatchCancelled() {
  return escapeV2('❎ Batch cancelled. Send a new file to try again.');
}

function buildBatchAborting() {
  return escapeV2('⏹ Aborting batch, please wait...');
}

function buildNoActiveBatch() {
  return escapeV2('⚠️ No active batch to abort.');
}

function buildBatchFailed(message) {
  return escapeV2(`⚠️ Batch failed: ${message}`);
}

function buildProcessingHotmail() {
  return escapeV2('⏳ Processing HOTMAIL file...');
}

function buildProcessingUlp() {
  return escapeV2('⏳ Processing ULP file...');
}

module.exports = {
  escapeV2,
  codeV2,
  boldV2,
  spoilerV2,
  spoilerCodeV2,
  maskEmail,
  formatBytes,
  formatDurationMs,
  // Common static
  buildStartMessage,
  buildHelpMessage,
  buildGuideMessage,
  // .chk
  buildGuardError,
  buildCheckQueued,
  buildCheckProgress,
  buildCheckResult,
  buildCheckAndCaptureResult,
  buildCheckError,
  // Capture
  buildCapturePrompt,
  buildCaptureExpired,
  buildCaptureSummary,
  buildCaptureFailed,
  buildCaptureSkipped,
  // Batch
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
  // extras
  codeSpan,
  Markup,
};
