const MAX_BYTES_HOTMAIL = 50 * 1024 * 1024; // 50MB
const MAX_BYTES_ULP = 1500 * 1024 * 1024; // 1.5GB

const ALLOWED_DOMAINS = [
  'live.jp',
  'hotmail.co.jp',
  'hotmail.jp',
  'outlook.jp',
  'outlook.co.jp',
  'msn.co.jp',
];

// Telegram Bot API file download limits
const TELEGRAM_FILE_LIMIT_CLOUD = 20 * 1024 * 1024; // 20MB (cloud API getFile limit)
const TELEGRAM_FILE_LIMIT_LOCAL = 2000 * 1024 * 1024; // 2000MB (local Bot API server with --local mode)

/**
 * Returns the Telegram file download limit based on whether a local Bot API server is configured.
 * When TELEGRAM_API_ROOT is set, the local Bot API server removes the 20MB download limit.
 * @param {string|undefined} apiRoot - Override for testability; defaults to process.env.TELEGRAM_API_ROOT
 * @returns {number} File size limit in bytes
 */
function getTelegramFileLimitBytes(apiRoot = process.env.TELEGRAM_API_ROOT) {
  return apiRoot ? TELEGRAM_FILE_LIMIT_LOCAL : TELEGRAM_FILE_LIMIT_CLOUD;
}

module.exports = {
  MAX_BYTES_HOTMAIL,
  MAX_BYTES_ULP,
  ALLOWED_DOMAINS,
  TELEGRAM_FILE_LIMIT_CLOUD,
  TELEGRAM_FILE_LIMIT_LOCAL,
  getTelegramFileLimitBytes,
};
