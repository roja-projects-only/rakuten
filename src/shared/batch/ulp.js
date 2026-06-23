const fs = require('fs');
const readline = require('readline');
const { fileURLToPath } = require('url');
const { MAX_BYTES_ULP } = require('./constants');
const { parseColonCredential } = require('./parse');
const { getWithRedirect } = require('./http');
const { createLogger } = require('../logger');

const log = createLogger('ulp');

function parseUlpFromUrl(fileUrl, maxBytes = MAX_BYTES_ULP) {
  return new Promise((resolve, reject) => {
    const seen = new Set();
    const creds = [];
    let total = 0;

    const processLine = (line) => {
      if (!line || typeof line !== 'string') return;
      if (!line.toLowerCase().includes('rakuten.co.jp')) return;
      // ULP format allows usernames without @ (not just emails)
      const parsed = parseColonCredential(line, { allowPrefix: true, requireEmail: false });
      if (!parsed) return;
      const key = `${parsed.user}:${parsed.pass}`;
      if (seen.has(key)) return;
      seen.add(key);
      creds.push({ username: parsed.user, password: parsed.pass });
    };

    const onClose = () => {
      log.info(`parsed creds: ${creds.length}, bytes: ${total}`);
      resolve({ creds, count: creds.length });
    };

    // Local Bot API server returns file:// URLs for files on its filesystem
    if (fileUrl.startsWith('file://')) {
      const filePath = fileURLToPath(fileUrl);
      log.info(`reading local file: ${filePath}`);
      const stream = fs.createReadStream(filePath);
      stream.on('error', (err) => {
        if (err.code === 'ENOENT') {
          reject(new Error(`File not found: ${filePath}. If running outside Docker, ensure the Bot API data volume is mounted.`));
        } else {
          reject(err);
        }
        return;
      });
      stream.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          stream.destroy();
          reject(new Error('File exceeds max allowed size'));
        }
      });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', processLine);
      rl.on('close', onClose);
      return;
    }

    // Existing HTTP download path
    log.info(`fetching: ${fileUrl}`);
    getWithRedirect(fileUrl)
      .then((res) => {
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            reject(new Error('File exceeds max allowed size'));
            res.destroy();
          }
        });

        const rl = readline.createInterface({ input: res, crlfDelay: Infinity });
        rl.on('line', processLine);
        rl.on('close', onClose);
      })
      .catch((err) => reject(err));
  });
}

async function prepareUlpBatch(fileUrl, maxBytes = MAX_BYTES_ULP) {
  return parseUlpFromUrl(fileUrl, maxBytes);
}

module.exports = {
  parseUlpFromUrl,
  prepareUlpBatch,
};
