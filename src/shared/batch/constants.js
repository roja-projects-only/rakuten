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

module.exports = {
  MAX_BYTES_HOTMAIL,
  MAX_BYTES_ULP,
  ALLOWED_DOMAINS,
};
