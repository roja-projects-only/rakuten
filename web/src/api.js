const API_BASE = import.meta.env.VITE_API_BASE || '';

async function fetchJson(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed (${res.status}): ${text || res.statusText}`);
  }
  return res.json();
}

export async function getStatus() {
  return fetchJson('/api/status');
}

export async function getRecentValids(limit = 50) {
  const url = `/api/valids?limit=${limit}`;
  return fetchJson(url);
}
