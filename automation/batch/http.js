const https = require('https');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
};

function getWithRedirect(url, { maxRedirects = 5, headers = DEFAULT_HEADERS } = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        if (REDIRECT_STATUSES.has(res.statusCode)) {
          if (redirectCount >= maxRedirects) {
            reject(new Error('Too many redirects'));
            res.resume();
            return;
          }
          const location = res.headers.location;
          if (!location) {
            reject(new Error('Redirect response missing Location header'));
            res.resume();
            return;
          }
          const nextUrl = new URL(location, url).toString();
          res.resume();
          resolve(getWithRedirect(nextUrl, { maxRedirects, headers }, redirectCount + 1));
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Download failed with status ${res.statusCode}`));
          res.resume();
          return;
        }

        const contentType = res.headers['content-type'] || '';
        if (contentType.includes('text/html')) {
          reject(new Error('URL returned HTML page (likely a download page). Provide a direct file link.'));
          res.resume();
          return;
        }

        resolve(res);
      })
      .on('error', (err) => reject(err));
  });
}

module.exports = {
  getWithRedirect,
};
