// LOCAL-ONLY: not for production services.
// @ts-check

'use strict';

const { Firecrawl } = require('firecrawl');
const { config } = require('./config');

// Properties inherited from Object.prototype — never wrap these (avoids
// spurious rate-limit delays on toString/valueOf/hasOwnProperty etc.).
const OBJECT_PROTO = new Set(Object.getOwnPropertyNames(Object.prototype));

/** @type {import('firecrawl').Firecrawl | null} */
let _client = null;

/**
 * Wraps a Firecrawl client instance in a Proxy that adds a post-call delay
 * after every async method invocation to respect rate limits.
 *
 * @template T
 * @param {T} client - The Firecrawl SDK client instance.
 * @param {number} delayMs - Delay in milliseconds to apply after each async call.
 * @returns {T} Proxied client.
 */
function withRateLimit(client, delayMs) {
  return new Proxy(client, {
    get(target, prop) {
      const orig = target[prop];
      if (typeof orig !== 'function' || OBJECT_PROTO.has(prop)) return orig;
      return async (...args) => {
        const result = await orig.apply(target, args);
        await new Promise((r) => setTimeout(r, delayMs));
        return result;
      };
    },
  });
}

/**
 * Returns a singleton Firecrawl client configured from environment variables.
 *
 * The client is wrapped with a rate-limit Proxy that enforces a post-call delay
 * (configurable via FIRECRAWL_REQUEST_DELAY_MS).
 *
 * @returns {import('firecrawl').Firecrawl} The wrapped (proxied) Firecrawl client.
 */
function getClient() {
  if (!_client) {
    const rawClient = new Firecrawl({ apiKey: config.apiKey });
    _client = withRateLimit(rawClient, config.requestDelayMs);
  }
  return _client;
}

module.exports = { getClient, withRateLimit };
