# Firecrawl Local Utility

Local-only Firecrawl wrapper for mapping public Rakuten endpoints and
authenticated page fetching via HTTP login. **Not for production services.**
Used only by `scripts/firecrawl/`.

For script usage and setup, see [../../docs/FIRECRAWL.md](../../docs/FIRECRAWL.md).

---

## Purpose

The production credential checker (`src/worker/`, `src/shared/http/flow.js`)
validates Rakuten credentials by replaying Rakuten's login API at the HTTP level
— crafted requests with fingerprinting, RAT payloads, and PoW crs. It never
sees the rendered page.

This utility fills the gap the API checker cannot: **what does Rakuten actually
show a logged-in user?** It uses two complementary approaches:

- **Public URL discovery** — Firecrawl's `/v2/map` endpoint (with the `enhanced`
  residential proxy and JP locale) to discover what URLs exist on rakuten.co.jp
  via sitemap + SERP, without needing credentials.
- **Authenticated page fetching** — the production HTTP login flow
  (`checkCredentials` with `deferCloseOnValid: true`) for a live impit session,
  then plain HTTP GETs (Axios) to fetch rendered pages. No Firecrawl browser
  interaction, no profiles, no 2FA pause.

Firecrawl is now used only for public URL discovery (`mapSite` / `/v2/map`) and
optional public page scraping. Authenticated page fetching uses the production
HTTP login flow directly (impit), which is free and bypasses Cloudflare.

This is an exploratory and debugging tool, not a production data pipeline. It
exists to answer "what's behind the login wall?" without manually browsing.

---

## How It Operates

### Data flow

```
                    Firecrawl Cloud API (api.firecrawl.dev)
                               │
                  ┌────────────┼────────────┐
                  ▼            ▼            │
             /v2/map      /v2/scrape        │
                  │            │            │
                  │            │            │
             map.js        scrape.js      auth.js
             mapSite()     scrapePage()   loginViaHttp()
             mapAndSave()  scrapeBatch()  closeHttpSession()
                                       │  writeLoginOutput()
                                  fetchPageViaHttp()
                                  extractLinksFromHtml()
                  │            │            │
                  └────────────┴────────────┘
                               │
                          client.js
                     (singleton + rate-limit Proxy)
                               │
                     ┌─────────┴─────────┐
                     ▼                   ▼
                config.js        Production impit HTTP
            (env validation)   (checkCredentials, Axios)
                               (bypasses Firecrawl)
                               │
                     scripts/firecrawl/*.js
                     (CLI entry points)
                               │
                     data/firecrawl/*.json
                     (output, gitignored)
```

### Module responsibilities

| Module | Role | Key exports |
|--------|------|-------------|
| `config.js` | Reads `FIRECRAWL_*` env vars, validates `FIRECRAWL_API_KEY` exists, applies defaults (proxy=enhanced, country=JP, languages=ja, delay=10000ms), computes a config hash for output metadata. Exports a frozen config object. | `config`, `validateConfig()` |
| `client.js` | Creates a singleton Firecrawl SDK client (`new Firecrawl({ apiKey })`). Wraps it in a Proxy that adds a post-call delay (`FIRECRAWL_REQUEST_DELAY_MS`) after every async method to respect rate limits. Excludes `Object.prototype` methods from wrapping. | `getClient()`, `withRateLimit()` |
| `map.js` | Wraps Firecrawl's `/v2/map` endpoint. Discovers URLs from sitemap + SERP with JP locale. Saves results to `data/firecrawl/map-{ts}.json` with embedded metadata. | `mapSite()`, `mapAndSave()` |
| `auth.js` | **HTTP-based login** via production `checkCredentials` (impit session reuse). Logs in with credentials, returns a live impit session for downstream HTTP fetches. Closes sessions safely. Writes lightweight login result logs. No Firecrawl interaction. | `loginViaHttp()`, `closeHttpSession()`, `writeLoginOutput()` |
| `scrape.js` | Two paths: (1) Firecrawl `/v2/scrape` via `scrapePage()` / `scrapeBatch()` — supports public and named-profile scraping with optional formats (markdown, html, rawHtml, links, images, screenshot). (2) HTTP fetch via `fetchPageViaHttp(url, session, options)` — fetches a page over HTTP using a logged-in impit session; returns synthetic result compatible with `extractEndpoints`. Note: `profile===true` is no longer supported. | `scrapePage()`, `scrapeBatch()`, `fetchPageViaHttp()` |
| `extract.js` | HTML-to-endpoint extraction: parses page links and raw HTML for API-like URLs, deduplicates, groups by category, and formats as Markdown. | `extractEndpoints()`, `extractLinksFromHtml(html, baseUrl)`, `groupEndpoints()`, `formatEndpointsMd()` |

### Authentication flow (auth.js)

```
1. loginViaHttp({ email, password }, { targetUrl })
   → calls checkCredentials(…, { deferCloseOnValid: true })
   → POW_SKIP_CONNECTION_TEST=1 set internally for local PoW
   → returns { success: true, session: impitSession } on VALID
   → returns { success: false, status, message } on failure

2. Fetch authed pages with session.client.get(url)
   or via fetchPageViaHttp(url, session, { timeout, maxRedirects })
   → returns synthetic { url, rawHtml, links, metadata: { statusCode }, success }

3. closeHttpSession(session)
   → wraps sessionManager.closeSession()
   → safe to call on null/undefined
```

The session is **in-memory only** — there is no persisted profile, no server-side
session storage, no ~15 min expiry. Each script invocation re-logins. The session
object contains the Axios client (and optional proxied client) from
`checkCredentials`, ready for direct HTTP requests.

- Credentials are passed through `checkCredentials`, never logged.
- `POW_SKIP_CONNECTION_TEST=1` is set automatically so the PoW service does not
  attempt a network connectivity test (not needed for local/dev use).
- The Firecrawl rate-limit Proxy does **not** apply to HTTP auth calls — they
  bypass Firecrawl entirely.

### Rate limiting

The Firecrawl rate-limit Proxy in `client.js` wraps only Firecrawl SDK methods
(`map`, `scrape`). HTTP auth and page fetching (`loginViaHttp`,
`fetchPageViaHttp`) bypass Firecrawl entirely and are not subject to the delay.

For Firecrawl SDK calls, `FIRECRAWL_REQUEST_DELAY_MS` (default 10s) applies
after each call completes:

```bash
FIRECRAWL_REQUEST_DELAY_MS=0 node scripts/firecrawl/login.js  # no effect on HTTP auth
FIRECRAWL_REQUEST_DELAY_MS=0 node scripts/firecrawl/map-public.js  # speeds up map
```

### Output format

Every output file embeds a `metadata` object for reproducibility:

```json
{
  "metadata": {
    "timestamp": "2026-06-26T12:00:00.000Z",
    "configHash": "f255bc29",
    "profileName": "rakuten-explorer",
    "script": "login-http",
    "baseUrl": "https://www.rakuten.co.jp",
    "linkCount": 247
  },
  "links": [...]
}
```

The `configHash` is a SHA-256 (first 8 chars) of the config minus the hash
field — changes to proxy, locale, or delay produce a different hash, making it
easy to correlate outputs with the config that produced them.

---

## Isolation from production

This module is deliberately kept out of the production service graph:

- **`firecrawl` is a devDependency** — `npm install --production` (used by
  Docker builds) excludes it. Production images have no Firecrawl code.
- **Not in `src/shared/index.js` barrel** — production modules cannot
  `require('../shared').firecrawl`.
- **Env vars not in `environment.js`** — production startup validation does not
  check `FIRECRAWL_*` vars. Scripts validate their own env via `config.js`.
- **Every file starts with `// LOCAL-ONLY: not for production services.`**

If a production module ever accidentally requires `src/firecrawl/config.js`, it
will `process.exit(1)` when `FIRECRAWL_API_KEY` is missing — a loud failure, not
a silent one.

---

## Security notes

- Credentials (email/password) are **never logged** at any level. They are
  passed directly to `checkCredentials`, which handles them internally.
- Error messages from the SDK are logged at `debug` level only (not `error`),
  to prevent credential leakage if the SDK includes request bodies in errors.
- `--dry-run` masks the password as `*****` and the email as first 2 + last 2
  characters.
- The login result saved to `data/firecrawl/login-{timestamp}.json` contains
  only `status` and `success` — no credentials, no session tokens.
- Sessions are in-memory only and closed on every code path (success, error, or
  finally block).

---

## Limitations

- **No persisted sessions:** Each script invocation re-logins. The session is
  in-memory only and closed after the script completes.
- **Captchas:** The HTTP flow uses the same fingerprinting / PoW as the
  production checker, which handles most Cloudflare challenges. Firecrawl's
  `enhanced` proxy avoids most captchas for public scraping.
- **Rate limits:** Default 10s delay between Firecrawl SDK calls. Adjust via
  `FIRECRAWL_REQUEST_DELAY_MS`. HTTP auth/fetch calls are not rate-limited by
  this utility.
- **ToS:** Authenticated scraping may violate Rakuten's Terms of Service. Use
  responsibly.
