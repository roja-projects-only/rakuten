const https = require('https');
const readline = require('readline');

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

function parseColonCredential(line) {
  if (!line || typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const parts = trimmed.split(':');
  if (parts.length !== 2) return null;

  const user = parts[0].trim();
  const pass = parts[1].trim();
  if (!user || !pass || !user.includes('@')) return null;

  return { user, pass };
}

function isAllowedHotmailUser(user) {
  const domain = user.split('@')[1];
  if (!domain) return false;
  const lower = domain.toLowerCase();
  return ALLOWED_DOMAINS.some((d) => lower.endsWith(d));
}

function downloadFileToBuffer(url, maxBytes = MAX_BYTES_HOTMAIL) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    https
      .get(url, (res) => {
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
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve(Buffer.concat(chunks));
        });
      })
      .on('error', (err) => reject(err));
  });
}

function parseCredentialsFromBuffer(buffer) {
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);
  const creds = [];
  for (const line of lines) {
    const parsed = parseColonCredential(line);
    if (!parsed) continue;
    if (!isAllowedHotmailUser(parsed.user)) continue;
    creds.push({ username: parsed.user, password: parsed.pass });
  }
  return creds;
}

async function prepareBatchFromFile(fileUrl, maxBytes = MAX_BYTES_HOTMAIL) {
  const buffer = await downloadFileToBuffer(fileUrl, maxBytes);
  const creds = parseCredentialsFromBuffer(buffer);
  return { creds, count: creds.length };
}

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
          const parsed = parseColonCredential(line);
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
  prepareBatchFromFile,
  prepareUlpBatch,
  ALLOWED_DOMAINS,
  MAX_BYTES_HOTMAIL,
  MAX_BYTES_ULP,
};
