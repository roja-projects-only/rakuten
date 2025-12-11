const https = require('https');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function getWithRedirect(url, { maxRedirects = 5 } = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
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
          resolve(getWithRedirect(nextUrl, { maxRedirects }, redirectCount + 1));
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Download failed with status ${res.statusCode}`));
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
