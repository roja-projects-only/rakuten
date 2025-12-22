const { createLogger } = require('../../logger');

const log = createLogger('proxy-redirect-cookies');

function buildUrlFromOptions(options = {}) {
  if (!options) return '';
  if (options.href) return options.href;

  const protocol = options.protocol || 'https:';
  const host = options.hostname || options.host;
  const port = options.port ? `:${options.port}` : '';
  const path = options.path || '';

  if (!host) return '';
  return `${protocol}//${host}${port}${path}`;
}

function setCookiesSyncSafe(jar, setCookieHeaders, url) {
  if (!jar || !setCookieHeaders || !url) return;

  const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const cookie of cookies) {
    try {
      if (typeof jar.setCookieSync === 'function') {
        jar.setCookieSync(cookie, url);
      } else if (typeof jar.setCookie === 'function') {
        jar.setCookie(cookie, url);
      }
    } catch (err) {
      log.debug(`Failed to set redirect cookie: ${err.message}`);
    }
  }
}

function getCookieHeaderSyncSafe(jar, url) {
  if (!jar || !url) return '';

  try {
    if (typeof jar.getCookieStringSync === 'function') {
      return jar.getCookieStringSync(url);
    }
    if (typeof jar.getCookieString === 'function') {
      return jar.getCookieString(url);
    }
  } catch (err) {
    log.debug(`Failed to read redirect cookies: ${err.message}`);
  }

  return '';
}

function attachProxyRedirectCookieHandling(client, jar) {
  if (!client || !jar) return;

  client.defaults.beforeRedirect = (options, responseDetails = {}) => {
    try {
      const headers = responseDetails.headers || {};
      const setCookieHeaders = headers['set-cookie'] || headers['Set-Cookie'];
      const sourceUrl = responseDetails.responseUrl || buildUrlFromOptions(responseDetails.request || responseDetails) || buildUrlFromOptions(options);

      setCookiesSyncSafe(jar, setCookieHeaders, sourceUrl);

      const nextUrl = buildUrlFromOptions(options) || sourceUrl;
      const cookieHeader = getCookieHeaderSyncSafe(jar, nextUrl);
      if (cookieHeader) {
        options.headers = options.headers || {};
        options.headers.Cookie = cookieHeader;
      }
    } catch (err) {
      log.debug(`beforeRedirect cookie hook failed: ${err.message}`);
    }
  };
}

module.exports = {
  attachProxyRedirectCookieHandling,
};
