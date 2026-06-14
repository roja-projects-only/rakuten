const { MAX_BYTES_HOTMAIL } = require('./constants');
const { parseColonCredential, isAllowedHotmailUser } = require('./parse');
const { getWithRedirect } = require('./http');

function downloadFileToBuffer(url, maxBytes = MAX_BYTES_HOTMAIL) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    getWithRedirect(url)
      .then((res) => {
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            reject(new Error('File exceeds max allowed size'));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .catch((err) => reject(err));
  });
}

function parseHotmailCredentialsFromBuffer(buffer) {
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);
  const creds = [];
  const seen = new Set();
  for (const line of lines) {
    const parsed = parseColonCredential(line);
    if (!parsed) continue;
    if (!isAllowedHotmailUser(parsed.user)) continue;
    const key = `${parsed.user}:${parsed.pass}`;
    if (seen.has(key)) continue;
    seen.add(key);
    creds.push({ username: parsed.user, password: parsed.pass });
  }
  return creds;
}

/**
 * Parse ALL credentials from buffer without domain filtering.
 * @param {Buffer} buffer - File buffer
 * @returns {Array} Parsed credentials
 */
function parseAllCredentialsFromBuffer(buffer) {
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);
  const creds = [];
  const seen = new Set();
  for (const line of lines) {
    const parsed = parseColonCredential(line);
    if (!parsed) continue;
    const key = `${parsed.user}:${parsed.pass}`;
    if (seen.has(key)) continue;
    seen.add(key);
    creds.push({ username: parsed.user, password: parsed.pass });
  }
  return creds;
}

/**
 * Check if email domain contains .jp
 * @param {string} user - Email address
 * @returns {boolean}
 */
function isJpDomain(user) {
  const domain = user.split('@')[1];
  if (!domain) return false;
  return domain.toLowerCase().includes('.jp');
}

/**
 * Parse credentials with .jp domains only.
 * @param {Buffer} buffer - File buffer
 * @returns {Array} Parsed credentials
 */
function parseJpCredentialsFromBuffer(buffer) {
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);
  const creds = [];
  const seen = new Set();
  for (const line of lines) {
    const parsed = parseColonCredential(line);
    if (!parsed) continue;
    if (!isJpDomain(parsed.user)) continue;
    const key = `${parsed.user}:${parsed.pass}`;
    if (seen.has(key)) continue;
    seen.add(key);
    creds.push({ username: parsed.user, password: parsed.pass });
  }
  return creds;
}

async function prepareHotmailBatch(fileUrl, maxBytes = MAX_BYTES_HOTMAIL) {
  const buffer = await downloadFileToBuffer(fileUrl, maxBytes);
  const creds = parseHotmailCredentialsFromBuffer(buffer);
  return { creds, count: creds.length };
}

/**
 * Prepare batch from file without any domain filtering.
 * @param {string} fileUrl - URL to download file from
 * @param {number} maxBytes - Max file size
 * @returns {Object} { creds, count }
 */
async function prepareAllBatch(fileUrl, maxBytes = MAX_BYTES_HOTMAIL) {
  const buffer = await downloadFileToBuffer(fileUrl, maxBytes);
  const creds = parseAllCredentialsFromBuffer(buffer);
  return { creds, count: creds.length };
}

/**
 * Prepare batch from file with .jp domain filter.
 * @param {string} fileUrl - URL to download file from
 * @param {number} maxBytes - Max file size
 * @returns {Object} { creds, count }
 */
async function prepareJpBatch(fileUrl, maxBytes = MAX_BYTES_HOTMAIL) {
  const buffer = await downloadFileToBuffer(fileUrl, maxBytes);
  const creds = parseJpCredentialsFromBuffer(buffer);
  return { creds, count: creds.length };
}

module.exports = {
  downloadFileToBuffer,
  parseHotmailCredentialsFromBuffer,
  parseAllCredentialsFromBuffer,
  parseJpCredentialsFromBuffer,
  prepareHotmailBatch,
  prepareAllBatch,
  prepareJpBatch,
};
