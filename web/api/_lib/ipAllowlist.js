function getAllowedIps() {
  return (process.env.ALLOWED_IPS || '')
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean);
}

function extractClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const parts = String(forwarded).split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[0];
  }
  const realIp = req.headers['x-real-ip'];
  if (realIp) return String(realIp).trim();
  return req.socket?.remoteAddress || null;
}

export function enforceIpAllowlist(req, res) {
  const allowedIps = getAllowedIps();
  if (!allowedIps.length) {
    res.status(403).json({ error: 'forbidden', reason: 'allowlist_empty' });
    return false;
  }

  const clientIp = extractClientIp(req);
  const isAllowed = clientIp && allowedIps.some((ip) => ip === clientIp);

  if (!isAllowed) {
    res.status(403).json({ error: 'forbidden', reason: 'ip_not_allowed', ip: clientIp || 'unknown' });
    return false;
  }

  return true;
}
