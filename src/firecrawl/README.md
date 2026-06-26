# Firecrawl Local Utility

Local-only Firecrawl wrapper for mapping public Rakuten endpoints and exploring
authenticated areas via browser-based scraping. **Not for production services.**
Used only by `scripts/firecrawl/`.

For script usage and setup, see [../../docs/FIRECRAWL.md](../../docs/FIRECRAWL.md).

---

## Purpose

The production credential checker (`src/worker/`, `src/shared/http/flow.js`)
validates Rakuten credentials by replaying Rakuten's login API at the HTTP level
— crafted requests with fingerprinting, RAT payloads, and PoW cres. It never
sees the rendered page.

This utility fills the gap the API checker cannot: **what does Rakuten actually
show a logged-in user?** It uses Firecrawl's cloud browser (with the `enhanced`
residential proxy and JP locale) to:

1. **Map** public endpoints — discover what URLs exist on rakuten.co.jp via
   sitemap + SERP, without needing credentials.
2. **Log in** with real credentials through a real browser session — filling the
   login form, handling 2FA, and persisting the authenticated profile
   server-side for reuse.
3. **Explore** authenticated pages — scrape the rendered content (markdown,
   HTML, screenshots, links) of pages only visible to logged-in users.

This is an exploratory and debugging tool, not a production data pipeline. It
exists to answer "what's behind the login wall?" without manually browsing.

---

## How It Operates

### Data flow

```
                    Firecrawl Cloud API (api.firecrawl.dev)
                              │
                 ┌────────────┼────────────┐
                 ▼            ▼            ▼
            /v2/map      /v2/scrape   /v2/scrape/{id}/interact
                 │            │            │
                 │            │            │
        map.js         scrape.js        auth.js
        mapSite()      scrapePage()    loginAndPersist()
        mapAndSave()   scrapeBatch()   loadProfileMetadata()
                 │            │            │
                 └────────────┴────────────┘
                              │
                         client.js
                    (singleton + rate-limit Proxy)
                              │
                         config.js
                    (env validation + frozen config)
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
| `auth.js` | Browser-based login flow: scrapes the login page (no formats — saves credits), extracts `scrapeId`, fills credentials via `interact` (natural language prompt or raw Playwright code), detects/handles 2FA via stdin, waits for redirect, calls `stopInteraction` to persist the profile server-side. Stores local profile metadata in `data/firecrawl/profiles/`. | `loginAndPersist()`, `loadProfileMetadata()` |
| `scrape.js` | Wraps Firecrawl's `/v2/scrape` endpoint. Supports public (no profile) and authenticated (saved profile) scraping. Optional formats: markdown, html, rawHtml, links, images, screenshot. Batch mode iterates URLs with configurable concurrency. | `scrapePage()`, `scrapeBatch()` |

### Authentication flow (auth.js)

```
1. scrape(loginUrl, { profile: { name, saveChanges: true }, formats: [] })
   → creates browser session, returns scrapeId
2. interact(scrapeId, { prompt: "Fill email + password, click submit" })
   → fills login form in the cloud browser
3. interact(scrapeId, { prompt: "Check if 2FA appeared" })
   → if 2FA detected: prompt user for code via stdin
   → interact(scrapeId, { prompt: "Fill 2FA code, submit" })
4. interact(scrapeId, { prompt: "Wait for redirect, report URL" })
   → confirms login succeeded
5. stopInteraction(scrapeId)
   → saves profile server-side (cookies, localStorage)
6. saveProfileMetadata() → local JSON in data/firecrawl/profiles/
```

The saved profile is then reused by `scrape.js` with `saveChanges: false`
(read-only) for authenticated scraping — no re-login needed until the ~15 min
session expires.

### Rate limiting

`client.js` wraps every SDK method in a Proxy that awaits a configurable delay
(`FIRECRAWL_REQUEST_DELAY_MS`, default 10s) after each call completes. This
applies to `map`, `scrape`, `interact`, and `stopInteraction` uniformly.

For the login flow (4-5 sequential interact calls), the 10s delay adds 40-50s
of overhead. Set `FIRECRAWL_REQUEST_DELAY_MS=0` for login to avoid this:

```bash
FIRECRAWL_REQUEST_DELAY_MS=0 node scripts/firecrawl/login.js
```

### Output format

Every output file embeds a `metadata` object for reproducibility:

```json
{
  "metadata": {
    "timestamp": "2026-06-26T12:00:00.000Z",
    "configHash": "f255bc29",
    "profileName": "rakuten-explorer",
    "script": "map-public",
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

- Credentials (email/password) are **never logged** at any level. The
  `buildLoginPrompt()` function in `auth.js` constructs the interact prompt with
  plaintext credentials but is never called inside a log statement.
- Error messages from the SDK are logged at `debug` level only (not `error`),
  to prevent credential leakage if the SDK includes request bodies in errors.
- `--dry-run` masks the password as `*****` and the email as first 2 + last 2
  characters.
- Profile metadata stored locally (`data/firecrawl/profiles/`) contains only
  `profileName`, `scrapeId`, `loginUrl`, `savedAt`, `configHash` — no
  credentials. The actual session state (cookies, localStorage) lives on
  Firecrawl's servers.

---

## Limitations

- **Session expiry:** Profiles expire ~15 minutes after login. Re-run
  `login.js` to refresh.
- **2FA:** Firecrawl cannot solve 2FA automatically. The login script prompts
  for the code via stdin with a 5-minute timeout.
- **Captchas:** No native captcha solving. The `enhanced` proxy avoids most,
  but hCaptcha/Turnstile may still trigger.
- **Rate limits:** Default 10s delay between calls. Adjust via
  `FIRECRAWL_REQUEST_DELAY_MS`.
- **ToS:** Authenticated scraping may violate Rakuten's Terms of Service. Use
  responsibly.