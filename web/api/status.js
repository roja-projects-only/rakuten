import { enforceIpAllowlist } from './_lib/ipAllowlist.js';

const TIMEOUT_MS = 5000;

async function fetchJson(url) {
  if (!url) return { error: 'url_not_configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return { error: `HTTP ${res.status}`, url };
    }
    const data = await res.json();
    return { data, url };
  } catch (error) {
    clearTimeout(timer);
    return { error: error.message, url };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (!enforceIpAllowlist(req, res)) return;

  const coordinatorUrl = process.env.COORDINATOR_STATUS_URL;
  const powHealthUrl = process.env.POW_SERVICE_HEALTH_URL || process.env.POW_SERVICE_URL?.replace(/\/$/, '') + '/health';
  const powStatsUrl = process.env.POW_SERVICE_STATS_URL || process.env.POW_SERVICE_URL?.replace(/\/$/, '') + '/stats';

  const [coordinator, powHealth, powStats] = await Promise.all([
    fetchJson(coordinatorUrl),
    fetchJson(powHealthUrl),
    fetchJson(powStatsUrl),
  ]);

  res.status(200).json({
    timestamp: Date.now(),
    coordinator,
    powService: {
      health: powHealth.data || null,
      stats: powStats.data || null,
      error: powHealth.error || powStats.error || null,
    },
  });
}
