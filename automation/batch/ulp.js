const https = require('https');
const readline = require('readline');
const { MAX_BYTES_ULP } = require('./constants');
const { parseColonCredential } = require('./parse');

function parseUlpFromUrl(fileUrl, maxBytes = MAX_BYTES_ULP) {
  return new Promise((resolve, reject) => {
    const seen = new Set();
    const creds = [];
    let total = 0;
    https
      .get(fileUrl, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed with status ${res.statusCode}`));
          res.resume();
          return;
        }

        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            reject(new Error('File exceeds max allowed size'));
            res.destroy();
          }
        });

        const rl = readline.createInterface({ input: res, crlfDelay: Infinity });
        rl.on('line', (line) => {
          if (!line || typeof line !== 'string') return;
          if (!line.toLowerCase().includes('rakuten.co.jp')) return;
          const parsed = parseColonCredential(line, { allowPrefix: true });
          if (!parsed) return;
          const key = `${parsed.user}:${parsed.pass}`;
          if (seen.has(key)) return;
          seen.add(key);
          creds.push({ username: parsed.user, password: parsed.pass });
        });

        rl.on('close', () => {
          resolve({ creds, count: creds.length });
        });
      })
      .on('error', (err) => reject(err));
  });
}

async function prepareUlpBatch(fileUrl, maxBytes = MAX_BYTES_ULP) {
  return parseUlpFromUrl(fileUrl, maxBytes);
}

module.exports = {
  parseUlpFromUrl,
  prepareUlpBatch,
};
