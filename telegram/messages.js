const { Markup } = require('telegraf');

// MarkdownV2 escapers/helpers
function escapeV2(text = '') {
  return String(text).replace(/[\\_*\[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function codeV2(text = '') {
  return `\`${escapeV2(text)}\``;
}

function boldV2(text = '') {
  return `*${escapeV2(text)}*`;
}

function spoilerV2(text = '') {
  return `||${escapeV2(text)}||`;
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
    '\n\n' + '✨ Fast, secure, automated validation' +
    '\n' + '📖 How to use: ' + codeV2('.chk email:password') +
    '\n' + '🧭 Example: ' + codeV2('.chk user@example.com:mypass123') +
    '\n\n' + '🔒 Features:' +
    '\n• Live status edits' +
    '\n• Evidence on demand' +
    '\n• Masked credentials' +
    '\n• Inline actions'
  );
}

function buildHelpMessage() {
  return (
    '❓ ' + boldV2('Help & Support') +
    '\n\nFormat: ' + codeV2('.chk email:password') +
    '\nStatus:' +
    '\n✅ VALID — works' +
    '\n❌ INVALID — wrong creds' +
    '\n🔒 BLOCKED — locked/verification' +
    '\n⚠️ ERROR — technical issue' +
    '\n\nNotes:' +
    '\n• Max 200 chars' +
    '\n• Single colon separator' +
    '\n• Replies stay in this chat'
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
    launch: '⏳ Launching browser...',
    navigate: '🌐 Navigating to login page...',
    email: '✉️ Submitting email...',
    password: '🔑 Submitting password...',
    analyze: '🔍 Analyzing result...',
  };
  return escapeV2(map[phase] || '⏳ Working...');
}

function buildCheckResult(result, username = null, durationMs = null) {
  const statusEmoji = { VALID: '✅', INVALID: '❌', BLOCKED: '🔒', ERROR: '⚠️' };
  const statusLabel = {
    VALID: 'VALID CREDENTIALS',
    INVALID: 'INVALID CREDENTIALS',
    BLOCKED: 'ACCOUNT BLOCKED',
    ERROR: 'ERROR OCCURRED',
  };

  const emoji = statusEmoji[result.status] || '❓';
  const status = boldV2(statusLabel[result.status] || result.status || 'STATUS');

  const parts = [];
  parts.push(`${emoji} ${status}`);

  if (username) {
    const maskedUser = maskEmail(username);
    parts.push(`${boldV2('👤 Account')}: ${codeV2(maskedUser)}`);
  }

  if (durationMs != null) {
    const seconds = durationMs / 1000;
    const pretty = seconds >= 10 ? seconds.toFixed(1) : seconds.toFixed(2);
    parts.push(`${boldV2('🕒 Time')}: ${codeV2(`${pretty}s`)}`);
  }

  parts.push(`${boldV2('📝 Result')}: ${escapeV2(result.message || '')}`);

  if (result.url) {
    const shortUrl = result.url.length > 120 ? `${result.url.substring(0, 117)}...` : result.url;
    parts.push(`${boldV2('🔗 Final URL')}: ${codeV2(shortUrl)}`);
  }

  if (result.screenshot) {
    parts.push(boldV2('📸 Screenshot attached'));
  }

  return parts.join('\n');
}

function buildCheckError(message) {
  return (
    '⚠️ ' + boldV2('ERROR OCCURRED') +
    '\n\n❌ ' + escapeV2(message) +
    '\n\n' + italicV2('Try again or contact support')
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
    `\n• Username: ${spoilerV2(codeV2(username || 'unknown'))}` +
    `\n• Password: ${spoilerV2(codeV2(password || 'hidden'))}`
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
  return escapeV2('⚠️ File too large for Telegram bots (max ~50MB). For ULP lists, host the file and use `.ulp <url>` instead.');
}

function buildFileReceived({ filename, size }) {
  return (
    '📂 ' + boldV2('File received') +
    `\n• Name: ${codeSpan(filename || 'file')}` +
    `\n• Size: ${escapeV2(formatBytes(size))}` +
    '\n\nProcess as HOTMAIL list?'
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
  return `ℹ️ No eligible ${escapeV2(contextText)} credentials found.`;
}

function buildAllProcessed(contextText) {
  return `ℹ️ All eligible credentials ${escapeV2(contextText)} were processed in the last 24h.`;
}

function buildBatchParseFailed(message) {
  return `⚠️ Failed to read: ${escapeV2(message)}`;
}

function buildBatchConfirmStart({ filename, count, skipped }) {
  return (
    escapeV2('⏳ Starting batch check') +
    `\nFile: ${codeSpan(filename)}` +
    `\nEntries: *${escapeV2(String(count))}*` +
    `\nSkipped (24h): *${escapeV2(String(skipped || 0))}*`
  );
}

function buildBatchProgress({ filename, processed, total, counts }) {
  return (
    escapeV2('⏳ Batch progress') +
    `\nFile: ${codeSpan(filename)}` +
    `\nProcessed: *${processed}/${total}*` +
    `\n✅ VALID: *${counts.VALID || 0}*` +
    `\n❌ INVALID: *${counts.INVALID || 0}*` +
    `\n🔒 BLOCKED: *${counts.BLOCKED || 0}*` +
    `\n⚠️ ERROR: *${counts.ERROR || 0}*`
  );
}

function buildBatchSummary({ filename, total, skipped, counts, elapsedMs, validCreds }) {
  const items = (validCreds && validCreds.length)
    ? validCreds.map((cred) => `• ${spoilerV2(codeV2(`${cred.username}:${cred.password}`))}`)
    : [escapeV2('• None')];

  const title = skipped ? '📊 Batch complete (with skips)' : '📊 Batch complete';

  return (
    escapeV2(title) +
    `\nFile: ${codeSpan(filename)}` +
    `\nTotal: *${total}*` +
    `\nSkipped (24h): *${skipped || 0}*` +
    `\n✅ VALID: *${counts.VALID || 0}*` +
    `\n❌ INVALID: *${counts.INVALID || 0}*` +
    `\n🔒 BLOCKED: *${counts.BLOCKED || 0}*` +
    `\n⚠️ ERROR: *${counts.ERROR || 0}*` +
    `\n🕒 Time: *${escapeV2(formatDurationMs(elapsedMs))}*` +
    `\n\n${escapeV2('VALID accounts:')}` +
    `\n${items.join('\n')}`
  );
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
  return `⚠️ Batch failed: ${escapeV2(message)}`;
}

function buildProcessingHotmail() {
  return escapeV2('⏳ Processing HOTMAIL file...');
}

module.exports = {
  escapeV2,
  codeV2,
  boldV2,
  spoilerV2,
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
  // extras
  codeSpan,
  Markup,
};
