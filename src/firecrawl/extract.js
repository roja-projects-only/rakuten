// LOCAL-ONLY: not for production services.
// @ts-check

'use strict';

const { createLogger } = require('../shared/logger');

const log = createLogger('firecrawl:extract');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** API-like path fragments (lowercase, checked via .includes()) */
const API_PATH_PATTERNS = [
  '/api/', '/rest/', '/v1/', '/v2/', '/v3/',
  '/service/', '/gateway/', '/ichiba/', '/user/',
  '/cart/', '/order/', '/product/', '/search/',
  '/auth/', '/sso/', '/login/', '/account/',
  '/payment/', '/shipping/', '/graphql',
];

/** Subdomain prefixes that identify API hosts */
const API_SUBDOMAIN_PATTERNS = ['api.', 'gateway.', 'token.', 'challenger.'];

/** File extensions that are definitely not API endpoints */
const STATIC_EXT_RE = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2)([?#]|$)/i;

/**
 * Ordered group definitions for `groupEndpoints`.
 * Each entry: { name, keywords[] }. First keyword match wins.
 */
const GROUP_DEFS = [
  { name: 'Auth',     keywords: ['login', 'signin', 'auth', 'sso', 'token', 'oauth', 'session', 'logout'] },
  { name: 'Products', keywords: ['ichiba', 'product', 'item', 'catalog', 'inventory', 'listing', 'genre'] },
  { name: 'Search',   keywords: ['search', 'query', 'suggestion', 'autocomplete'] },
  { name: 'Cart',     keywords: ['cart', 'basket', 'checkout'] },
  { name: 'Orders',   keywords: ['order', 'purchase', 'history', 'transaction'] },
  { name: 'Account',  keywords: ['mypage', 'profile', 'settings', 'account', 'user', 'member'] },
  { name: 'Payments', keywords: ['payment', 'pay', 'billing', 'card', 'credit'] },
  { name: 'Shipping', keywords: ['shipping', 'delivery', 'address'] },
  { name: 'API',      keywords: ['api', 'rest', 'graphql', 'gateway', 'service'] },
  { name: 'Internal', keywords: ['internal', 'admin', 'cms', 'cdn', 'challenger'] },
  { name: 'Tracker',  keywords: ['rat', 'analytics', 'beacon', 'log', 'tracker', 'monitor'] },
];

/** Display order for group headings in markdown output. */
const GROUP_ORDER = [
  'Auth', 'Products', 'Search', 'Cart', 'Orders',
  'Account', 'Payments', 'Shipping', 'API', 'Internal', 'Tracker', 'Other',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a URL looks like an API endpoint.
 *
 * Matches common API path fragments (/api/, /v1/, /graphql, etc.) and
 * subdomain indicators (api., gateway., etc.).  Excludes static assets
 * (.js, .css, .png, etc.).
 *
 * @param {string} url - The URL to inspect.
 * @returns {boolean} `true` if the URL appears to be an API endpoint.
 */
function isApiLike(url) {
  try {
    const u = new URL(url);
    const pathname = u.pathname.toLowerCase();
    const hostname = u.hostname.toLowerCase();

    // Exclude static asset extensions
    if (STATIC_EXT_RE.test(pathname)) return false;

    // Check pathname fragments.
    // For patterns ending in '/' (e.g. /login/, /search/), also match
    // the bare path (e.g. /login, /search) since those are also valid
    // API endpoints.
    for (const pattern of API_PATH_PATTERNS) {
      if (pathname.includes(pattern)) return true;
      if (pattern.endsWith('/')) {
        const prefix = pattern.slice(0, -1);
        if (pathname === prefix) return true;
        if (pathname.startsWith(prefix + '/')) return true;
      }
    }

    // Check subdomain patterns
    for (const pattern of API_SUBDOMAIN_PATTERNS) {
      if (hostname.startsWith(pattern) || hostname.includes('.' + pattern)) return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Resolve a (possibly relative) URL against a base URL, then normalise it.
 *
 * Normalisation steps:
 * - Strips the fragment (#…).
 * - Removes trailing slash from paths longer than "/".
 *
 * @param {string} urlStr - The URL to normalise (can be relative).
 * @param {string} baseUrl - Absolute base URL for resolving relative inputs.
 * @returns {string|null} The fully-qualified, normalised URL, or `null` when
 *   the input cannot be parsed.
 */
function normalizeUrl(urlStr, baseUrl) {
  if (!urlStr || (typeof urlStr === 'string' && !urlStr.trim())) return null;
  try {
    const u = new URL(urlStr, baseUrl);

    // Strip fragment
    u.hash = '';

    // Normalise trailing slash: keep only for root "/"
    const p = u.pathname;
    if (p.length > 1 && p.endsWith('/')) {
      u.pathname = p.replace(/\/+$/, '');
    }

    return u.href;
  } catch {
    return null;
  }
}

/**
 * Parse query-string parameters out of a URL and return them as a plain object.
 *
 * @param {string} urlStr - Fully-qualified URL.
 * @returns {Record<string, string>}
 */
function parseQueryParams(urlStr) {
  try {
    const u = new URL(urlStr);
    return Object.fromEntries(u.searchParams.entries());
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Regex patterns for extracting endpoint URLs from HTML / JS source text
// ---------------------------------------------------------------------------

/** @type {Array<{ re: RegExp, methodFrom: (m: RegExpExecArray) => string, inferred: boolean }>} */
const SOURCE_PATTERNS = [
  // fetch('…')
  { re: /fetch\(['"]([^'"]+)['"]/gi,            methodFrom: () => 'GET',  inferred: true },

  // axios.get|post|put|delete|patch('…')
  { re: /axios\.(get|post|put|delete|patch)\(['"]([^'"]+)['"]/gi,
    methodFrom: (m) => m[1], inferred: true },

  // .open(method, url)  — XHR / fetch-like
  { re: /\.open\(['"](\w+)['"],\s*['"]([^'"]+)['"]/gi,
    methodFrom: (m) => m[1], inferred: true },

  // $.ajax({ …, url: '…', … })
  { re: /\.ajax\(\{[^}]*?url:\s*['"]([^'"]+)['"]/gi,
    methodFrom: () => 'GET',  inferred: true },

  // action="…"  (form actions — POST unless method= is nearby)
  { re: /action=['"]([^'"]+)['"]/gi,
    methodFrom: (m, fullText) => {
      const ctx = fullText.slice(Math.max(0, m.index - 120), m.index + m[0].length + 120);
      const mm = ctx.match(/method=['"](\w+)['"]/i);
      return mm ? mm[1].toUpperCase() : 'POST';
    },
    inferred: true },

  // data-api="…"
  { re: /data-api=['"]([^'"]+)['"]/gi,           methodFrom: () => 'GET',  inferred: true },

  // data-url="…"
  { re: /data-url=['"]([^'"]+)['"]/gi,           methodFrom: () => 'GET',  inferred: true },
];

/**
 * Extract API endpoints from a plain-text body (raw HTML or JS).
 *
 * @param {string} text - Source text to search.
 * @param {string} sourceLabel - Human-readable source description.
 * @param {string} baseUrl - Base URL for resolving relative paths.
 * @returns {Array<{method: string, path: string, fullUrl: string, params: Record<string,string>, source: string, inferred: boolean}>}
 */
function extractFromText(text, sourceLabel, baseUrl) {
  /** @type {Map<string, {method: string, path: string, fullUrl: string, params: Record<string,string>, source: string, inferred: boolean}>} */
  const seen = new Map();

  for (const pattern of SOURCE_PATTERNS) {
    pattern.re.lastIndex = 0;

    /** @type {RegExpExecArray|null} */
    let match;
    while ((match = pattern.re.exec(text)) !== null) {
      let urlStr;
      let method;

      // Most patterns: captured URL is at last capture group.
      // action/axios patterns: method derived from first group, URL from last.
      if (pattern.inferred && pattern.re.source.includes('axios')) {
        // axios: match[1] = method, match[2] = url
        method = match[1];
        urlStr = match[2];
      } else if (pattern.re.source.includes('\\.open\\(')) {
        // .open: match[1] = method, match[2] = url
        method = match[1];
        urlStr = match[2];
      } else if (pattern.re.source.includes('action=')) {
        // action: match[1] = url; method from surrounding context
        urlStr = match[1];
        method = pattern.methodFrom(match, text);
      } else {
        // fetch, jQuery, data-api, data-url: match[1] = url
        urlStr = match[1];
        method = pattern.methodFrom(match, text);
      }

      const normalized = normalizeUrl(urlStr, baseUrl);
      if (!normalized) continue;

      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;

      let u;
      try { u = new URL(normalized); } catch { continue; }

      seen.set(key, {
        method: method.toUpperCase(),
        path: u.pathname,
        fullUrl: normalized,
        params: parseQueryParams(normalized),
        source: sourceLabel,
        inferred: pattern.inferred,
      });
    }
  }

  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a Firecrawl scrape result for API endpoints.
 *
 * Sources searched (in priority order):
 *  1. `scrapeResult.links` — filtered via `isApiLike()`, inferred = false.
 *  2. `scrapeResult.rawHtml` — regex-matched API patterns, inferred = true.
 *  3. `scrapeResult.html`    — (if non-null) same regex patterns, inferred = true.
 *
 * Deduplication is case-insensitive on `fullUrl`; link-sourced entries
 * take precedence over regex-discovered entries with the same URL.
 *
 * @param {object} scrapeResult - Result from `scrapePage()`.
 * @param {string} scrapeResult.url - The scraped page URL.
 * @param {Array<{url: string, title?: string, description?: string}>} [scrapeResult.links] - Page links.
 * @param {string|null} [scrapeResult.rawHtml] - Raw HTML string.
 * @param {string|null} [scrapeResult.html] - Parsed HTML string.
 * @returns {Array<{method: string, path: string, fullUrl: string, params: Record<string,string>, source: string, inferred: boolean}>}
 */
function extractEndpoints(scrapeResult) {
  const baseUrl = scrapeResult.url || '';
  const sourceRoot = baseUrl;

  // Case-insensitive dedup key → entry
  /** @type {Map<string, {method: string, path: string, fullUrl: string, params: Record<string,string>, source: string, inferred: boolean}>} */
  const dedup = new Map();

  // ---- 1. Links (highest priority, inferred = false) ----
  const links = Array.isArray(scrapeResult.links) ? scrapeResult.links : [];
  for (const link of links) {
    if (!link || !link.url) continue;
    if (!isApiLike(link.url)) continue;

    const normalized = normalizeUrl(link.url, baseUrl);
    if (!normalized) continue;

    const key = normalized.toLowerCase();
    if (dedup.has(key)) continue;

    let u;
    try { u = new URL(normalized); } catch { continue; }

    dedup.set(key, {
      method: 'GET',
      path: u.pathname,
      fullUrl: normalized,
      params: parseQueryParams(normalized),
      source: `Found in links on ${sourceRoot}`,
      inferred: false,
    });
  }

  // ---- 2. Raw HTML (inferred = true, but does not override links) ----
  if (scrapeResult.rawHtml && typeof scrapeResult.rawHtml === 'string') {
    const rawEndpoints = extractFromText(
      scrapeResult.rawHtml,
      `Found in rawHtml on ${sourceRoot}`,
      baseUrl,
    );
    for (const ep of rawEndpoints) {
      const key = ep.fullUrl.toLowerCase();
      if (!dedup.has(key)) {
        dedup.set(key, ep);
      }
    }
  }

  // ---- 3. Parsed HTML (inferred = true, same dedup) ----
  if (scrapeResult.html && typeof scrapeResult.html === 'string') {
    const htmlEndpoints = extractFromText(
      scrapeResult.html,
      `Found in html on ${sourceRoot}`,
      baseUrl,
    );
    for (const ep of htmlEndpoints) {
      const key = ep.fullUrl.toLowerCase();
      if (!dedup.has(key)) {
        dedup.set(key, ep);
      }
    }
  }

  return Array.from(dedup.values());
}

/**
 * Find new API-like URLs from a scrape result that have not yet been
 * scraped or queued for scraping.
 *
 * @param {object} scrapeResult - Result from `scrapePage()`.
 * @param {Set<string>} scrapedSet - URLs already scraped.
 * @param {Set<string>} queuedSet - URLs already enqueued.
 * @returns {string[]} Unique list of new API-like URLs.
 */
function extractNewUrls(scrapeResult, scrapedSet, queuedSet) {
  const links = Array.isArray(scrapeResult.links) ? scrapeResult.links : [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const result = [];

  for (const link of links) {
    const url = link && link.url;
    if (!url) continue;
    if (!isApiLike(url)) continue;
    if (scrapedSet.has(url) || queuedSet.has(url)) continue;

    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(url);
  }

  return result;
}

/**
 * Extract links from an HTML string by matching `<a href="...">` and
 * `<form action="...">` tags.
 *
 * Resolves relative URLs against `baseUrl`, deduplicates case-insensitively,
 * and returns an array shaped like Firecrawl's `links` field.
 *
 * @param {string} html - Raw HTML source text.
 * @param {string} baseUrl - Base URL for resolving relative paths.
 * @returns {Array<{url: string}>} Deduplicated link objects.
 */
function extractLinksFromHtml(html, baseUrl) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Array<{url: string}>} */
  const result = [];

  // Match <a href="..."> and <a href='...'>
  const aRe = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi;
  // Match <form action="..."> and <form action='...'>
  const formRe = /<form\s+[^>]*action=["']([^"']+)["'][^>]*>/gi;

  /** @param {RegExp} re */
  const collect = (re) => {
    let m;
    while ((m = re.exec(html)) !== null) {
      const raw = (m[1] || '').trim();
      if (!raw) continue;
      if (/^(javascript:|mailto:|tel:|#)/i.test(raw)) continue;
      const resolved = normalizeUrl(raw, baseUrl);
      if (!resolved) continue;
      const key = resolved.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ url: resolved });
    }
  };

  collect(aRe);
  collect(formRe);

  return result;
}

/**
 * Group a list of endpoints by resource category.
 *
 * Each endpoint's `path` and `fullUrl` are checked (lowercased) against
 * keyword lists. The first matching category wins; unclassified endpoints
 * fall into `Other`.
 *
 * @param {Array<{method: string, path: string, fullUrl: string, params: Record<string,string>, source: string, inferred: boolean}>} endpoints
 * @returns {Record<string, Array<{method: string, path: string, fullUrl: string, params: Record<string,string>, source: string, inferred: boolean}>>}
 *   Grouped endpoints keyed by category name. Only non-empty groups are returned.
 */
function groupEndpoints(endpoints) {
  /** @type {Record<string, Array<object>>} */
  const groups = {};

  for (const ep of endpoints) {
    const haystack = `${ep.path} ${ep.fullUrl}`.toLowerCase();
    let assigned = false;

    for (const g of GROUP_DEFS) {
      if (g.keywords.some((kw) => haystack.includes(kw))) {
        if (!groups[g.name]) groups[g.name] = [];
        groups[g.name].push(ep);
        assigned = true;
        break;
      }
    }

    if (!assigned) {
      if (!groups.Other) groups.Other = [];
      groups.Other.push(ep);
    }
  }

  return groups;
}

/**
 * Format grouped endpoints as a Markdown document suitable for
 * `docs/api-endpoints.md`.
 *
 * @param {Record<string, Array<{method: string, path: string, fullUrl: string, params: Record<string,string>, source: string, inferred: boolean}>>} grouped
 *   Endpoints grouped by category (output of `groupEndpoints`).
 * @param {{ status: string, batchesCompleted: number, urlsScraped: number, urlsRemaining: number, endpointsFound: number, lastUpdated: string }} meta
 *   Scrape-run metadata.
 * @returns {string} Formatted Markdown.
 */
function formatEndpointsMd(grouped, meta) {
  /** @type {string[]} */
  const out = [];

  // ---- Optional alert banners ----
  if (meta.status === 'paused_credit_exhausted') {
    out.push(`> ⚠️ SCRAPE INCOMPLETE — Firecrawl credits exhausted after ${meta.batchesCompleted} batches.`);
    out.push('> Resume by re-running this task. Progress is saved in docs/api-scrape-progress.json.');
    out.push('');
  }

  // ---- Header ----
  out.push('# Rakuten API Endpoint Map');
  out.push('');

  // ---- Status line ----
  const statusDisplay = meta.status === 'complete' ? '✅ COMPLETE' : meta.status;
  out.push(`> **Scrape status:** ${statusDisplay}`);
  out.push(`> **Batches completed:** ${meta.batchesCompleted}`);
  out.push(`> **URLs scraped:** ${meta.urlsScraped} | **URLs remaining:** ${meta.urlsRemaining} | **Endpoints found:** ${meta.endpointsFound}`);
  out.push(`> **Last updated:** ${meta.lastUpdated}`);
  out.push('> **Resume file:** docs/api-scrape-progress.json');
  out.push('');

  // ---- Empty state ----
  const totalEndpoints = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);
  if (totalEndpoints === 0) {
    out.push('No endpoints discovered yet.');
    out.push('');
    return out.join('\n');
  }

  out.push('---');
  out.push('');

  // ---- Groups ----
  for (const groupName of GROUP_ORDER) {
    const eps = grouped[groupName];
    if (!eps || eps.length === 0) continue;

    // Sort alphabetically by path within the group
    eps.sort((a, b) => a.path.localeCompare(b.path));

    out.push(`## ${groupName}`);
    out.push('');

    for (const ep of eps) {
      out.push(`### \`${ep.method} ${ep.path}\``);
      out.push('**Description:** Endpoint discovered during scraping');
      out.push(`**Request params:** ${Object.keys(ep.params).length > 0 ? JSON.stringify(ep.params) : 'N/A'}`);
      out.push('**Request body:** N/A');
      out.push('**Response:** Unknown');
      out.push(`**Source:** ${ep.source}`);
      if (ep.inferred) {
        out.push('⚠️ inferred');
      }
      out.push('');
    }

    out.push('---');
    out.push('');
  }

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  isApiLike,
  normalizeUrl,
  extractEndpoints,
  extractNewUrls,
  extractLinksFromHtml,
  groupEndpoints,
  formatEndpointsMd,
};
