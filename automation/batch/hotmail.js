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
  for (const line of lines) {
    const parsed = parseColonCredential(line);
    if (!parsed) continue;
    if (!isAllowedHotmailUser(parsed.user)) continue;
    creds.push({ username: parsed.user, password: parsed.pass });
  }
  return creds;
}

async function prepareHotmailBatch(fileUrl, maxBytes = MAX_BYTES_HOTMAIL) {
  const buffer = await downloadFileToBuffer(fileUrl, maxBytes);
  const creds = parseHotmailCredentialsFromBuffer(buffer);
  return { creds, count: creds.length };
}

module.exports = {
  downloadFileToBuffer,
  parseHotmailCredentialsFromBuffer,
  prepareHotmailBatch,
};
