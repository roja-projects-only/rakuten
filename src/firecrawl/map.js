// LOCAL-ONLY: not for production services.
// @ts-check

'use strict';

const fs = require('fs');
const path = require('path');
const { getClient } = require('./client');
const { config } = require('./config');
const { createLogger } = require('../shared/logger');

const log = createLogger('firecrawl:map');

/**
 * Maps a site to discover accessible public URLs via Firecrawl's /v2/map
 * endpoint.
 *
 * @param {string} baseUrl - Root URL to start mapping from.
 * @param {object} [options={}] - Map options.
 * @param {number} [options.limit] - Max links to return (default 500).
 * @param {string} [options.search] - Optional search/filter term.
 * @param {boolean} [options.includeSubdomains] - Include subdomains (default true).
 * @param {object} [options.location] - Override location config.
 * @returns {Promise<Array<{ url: string, title?: string, description?: string }>>}
 */
async function mapSite(baseUrl, options = {}) {
  const mapOptions = {
    sitemap: 'include',
    location: options.location ?? config.location,
    limit: options.limit ?? 500,
    ...(options.search ? { search: options.search } : {}),
    includeSubdomains: options.includeSubdomains ?? true,
  };

  const result = await getClient().map(baseUrl, mapOptions);

  // Defensively extract links: SDK v4 returns MapData = { links: [...] },
  // but be tolerant of { data: { links: [...] } } as well.
  /** @type {Array<{ url: string, title?: string, description?: string }>} */
  let links;
  if (result && Array.isArray(result.links)) {
    links = result.links;
  } else if (result && result.data && Array.isArray(result.data.links)) {
    links = result.data.links;
  } else {
    log.warn('Unexpected map response shape — no links array found');
    links = [];
  }

  log.info(`mapSite found ${links.length} link(s) for ${baseUrl}`);
  if (options.search) {
    log.info(`  (filtered by search: "${options.search}")`);
  }

  return links;
}

/**
 * Maps a site and saves the result to a JSON file in data/firecrawl/.
 *
 * The output file contains embedded metadata (timestamp, config hash,
 * profile name) alongside the links array.
 *
 * @param {string} baseUrl - Root URL to start mapping from.
 * @param {object} [options={}] - Map options (same as mapSite).
 * @returns {Promise<{ filePath: string, linkCount: number, links: Array<{ url: string, title?: string, description?: string }> }>}
 */
async function mapAndSave(baseUrl, options = {}) {
  const links = await mapSite(baseUrl, options);

  const ts = new Date();
  const fileSafeTs = ts.toISOString().replace(/[:.]/g, '-');
  const filename = `map-${fileSafeTs}.json`;
  const dir = path.resolve(__dirname, '..', '..', 'data', 'firecrawl');

  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, filename);

  const output = {
    metadata: {
      timestamp: ts.toISOString(),
      configHash: config.hash,
      profileName: config.profileName,
      script: 'map-public',
      baseUrl,
      linkCount: links.length,
    },
    links,
  };

  fs.writeFileSync(filePath, JSON.stringify(output, null, 2), 'utf-8');

  log.info(`mapAndSave: saved ${links.length} link(s) to ${filePath}`);

  return { filePath, linkCount: links.length, links };
}

module.exports = { mapSite, mapAndSave };
