# Firecrawl Local Exploration Utility

Local-only utility for mapping public Rakuten endpoints and fetching authenticated pages via HTTP login. **Not used by production services** (coordinator/worker/pow-service).

## Overview

This utility lives in `src/firecrawl/` (modules) and `scripts/firecrawl/` (executable scripts). It uses the paid Firecrawl cloud API for public URL discovery (`/v2/map`) and optional public page scraping. Authenticated page fetching uses the production HTTP login flow (`checkCredentials` + impit session) directly — free, fast, and bypasses Cloudflare.

**Workflow:**
1. Map public endpoints (`map-public.js`)
2. Log in via HTTP to get an impit session (`login.js` — smoke test)
3. Fetch authenticated pages over HTTP (`scrape-authed.js`, `explore-batch.js`)
4. Run full API endpoint discovery (`api-discovery.js`)

## Setup

### 1. Add API key to `.env`

```
FIRECRAWL_API_KEY=your-paid-api-key-here
```

Optional Firecrawl env vars (defaults shown):
```
FIRECRAWL_PROFILE_NAME=rakuten-explorer
FIRECRAWL_PROXY=enhanced
FIRECRAWL_LOCATION_COUNTRY=JP
FIRECRAWL_LOCATION_LANGUAGES=ja
FIRECRAWL_REQUEST_DELAY_MS=10000
```

### 2. Credentials

The login script reads from existing env vars:
```
TEST_EMAIL=your-rakuten-email
TEST_PASSWORD=your-rakuten-password
TARGET_LOGIN_URL=https://login.account.rakuten.com/sso/authorize?...
```

You can also pass credentials via CLI flags: `--email`, `--password`.

### 3. Verify setup (dry-run)

All scripts support `--dry-run` which prints config and exits without calling any API:

```bash
node scripts/firecrawl/map-public.js --dry-run
node scripts/firecrawl/login.js --dry-run
node scripts/firecrawl/scrape-authed.js https://www.rakuten.co.jp --dry-run
node scripts/firecrawl/explore-batch.js data/firecrawl/test-urls.txt --dry-run
node scripts/firecrawl/api-discovery.js --dry-run
```

## Scripts

### Map public endpoints

```bash
node scripts/firecrawl/map-public.js [baseUrl] [--search <term>] [--limit <n>]
```

Discovers URLs via Firecrawl's `/v2/map` endpoint (sitemap + SERP). Output: `data/firecrawl/map-{timestamp}.json`.

| Flag | Default | Description |
|------|---------|-------------|
| `baseUrl` | `TARGET_LOGIN_URL` origin or `https://www.rakuten.co.jp` | Root URL to map |
| `--search` | (none) | Filter term for URL discovery |
| `--limit` | 500 | Max URLs to return |
| `--dry-run` | — | Print config, exit without API call |

### HTTP login smoke test

```bash
node scripts/firecrawl/login.js [loginUrl] [--email <email>] [--password <pwd>]
```

Logs in via the production `checkCredentials` flow and writes a login result log. The session is held only for this script's lifetime (smoke test).

| Flag | Default | Description |
|------|---------|-------------|
| `loginUrl` | `TARGET_LOGIN_URL` | Login page URL |
| `--email` | `TEST_EMAIL` | Rakuten account email |
| `--password` | `TEST_PASSWORD` | Rakuten account password |
| `--dry-run` | — | Print masked config, exit without API call |

Output: `data/firecrawl/login-{timestamp}.json` (login result metadata with no secrets).

### Scrape a single authenticated page (HTTP)

```bash
node scripts/firecrawl/scrape-authed.js <url> [--email <email>] [--password <pwd>] [--timeout <ms>]
```

Self-logs in via HTTP (`loginViaHttp`), fetches a single URL via `fetchPageViaHttp` using the impit session, writes the result, and closes the session.

| Flag | Default | Description |
|------|---------|-------------|
| `url` | (required) | URL to fetch |
| `--email` | `TEST_EMAIL` | Rakuten account email |
| `--password` | `TEST_PASSWORD` | Rakuten account password |
| `--timeout` | 30000 | Request timeout in milliseconds |
| `--dry-run` | — | Print config, exit without API call |

Output: `data/firecrawl/scrape-http-{slug}-{timestamp}.json`.

### Batch fetch multiple URLs (HTTP)

```bash
node scripts/firecrawl/explore-batch.js <urlsFile> [--timeout <ms>]
```

Batch-fetch multiple URLs over HTTP. Self-logs in, fetches each URL sequentially via `fetchPageViaHttp`, writes a summary, and closes the session. The URLs file should contain one URL per line (`#` comments and blank lines ignored).

| Flag | Default | Description |
|------|---------|-------------|
| `urlsFile` | (required) | File with one URL per line |
| `--timeout` | 30000 | Request timeout in milliseconds |
| `--dry-run` | — | Read file, count URLs, exit without API call |

Output: `data/firecrawl/batch-http-{timestamp}.json`.

### API endpoint discovery

```bash
node scripts/firecrawl/api-discovery.js [--dry-run] [--relogin] [--batch-size <n>] [--relogin-interval-min <n>] [--save-failures]
```

Orchestrates full API endpoint discovery: HTTP login → seed URLs (OpenAPI check, Firecrawl map, seed page fetches, known patterns) → batched HTTP fetching with endpoint extraction → writes `docs/api-endpoints.md` + `docs/api-scrape-progress.json`. Resumable — progress is saved after each batch.

| Flag | Default | Description |
|------|---------|-------------|
| `--dry-run` | — | Print plan, exit without API calls |
| `--relogin` | — | Force fresh start (ignore saved progress) |
| `--batch-size` | 20 | URLs per batch |
| `--relogin-interval-min` | 10 | Re-login after this many minutes |
| `--save-failures` | — | Save failed URL metadata to `data/firecrawl/failed/` |

Output: `docs/api-endpoints.md` (discovered endpoint map) + `docs/api-scrape-progress.json` (resumable discovery state).

## Output

All output is written to `data/firecrawl/` (gitignored), plus two files in `docs/`:

| File pattern | Content |
|-------------|---------|
| `map-{timestamp}.json` | Discovered URLs from map |
| `login-{timestamp}.json` | Login result metadata (status, success; no secrets) |
| `scrape-http-{slug}-{timestamp}.json` | Single HTTP page fetch result |
| `batch-http-{timestamp}.json` | Batch HTTP fetch summary |
| `docs/api-endpoints.md` | Discovered endpoint map |
| `docs/api-scrape-progress.json` | Resumable discovery progress |

Each output file embeds metadata: `timestamp`, `configHash`, `script`.

## Architecture

```
src/firecrawl/
  config.js     — Env validation, frozen config object, config hash
  client.js     — Singleton Firecrawl SDK client with rate-limit Proxy
  map.js        — mapSite() + mapAndSave() for /v2/map
  auth.js       — loginViaHttp() + closeHttpSession() + writeLoginOutput()
                  HTTP-based login via production checkCredentials
  scrape.js     — scrapePage() + scrapeBatch() + fetchPageViaHttp()
                  Firecrawl scrape + HTTP page fetch
  extract.js    — extractEndpoints() + extractLinksFromHtml() + grouping/formatting helpers
  progress.js   — Progress file I/O for api-discovery
  README.md     — Pointer to this doc

scripts/firecrawl/
  map-public.js     — Map public endpoints
  login.js          — HTTP login smoke test
  scrape-authed.js  — Scrape single authed page over HTTP
  explore-batch.js  — Batch fetch from URLs file
  api-discovery.js  — Full API endpoint discovery orchestrator
```

**Key design decisions:**
- `firecrawl` installed as `devDependency` — keeps it out of production Docker images
- Env vars self-validated in `config.js` (not in production `environment.js`)
- Rate limiting centralized in `client.js` via Proxy (post-call delay)
- Authenticated page fetching uses the production HTTP login flow (impit) — no Firecrawl credits burned for authed pages
- Sessions are in-memory only (re-login per invocation); `POW_SKIP_CONNECTION_TEST=1` set internally
- Session cleanup via `closeHttpSession` in `finally` blocks (process.exitCode pattern to ensure finally runs)
- Credentials never logged at any level
- `--dry-run` works without API key (runs before validation)

## Limitations

- **Session lifetime:** HTTP sessions are in-memory and re-created per script invocation (~3-5s login). No persisted sessions.
- **2FA:** The HTTP login flow returns INVALID/ERROR if 2FA is required. Disable 2FA on the test account.
- **Captchas:** No native captcha solving. The HTTP flow uses the same fingerprinting / PoW as the production checker, which handles most Cloudflare challenges. Firecrawl's `enhanced` proxy avoids most captchas for public scraping.
- **Rate limits:** Default 10s delay between Firecrawl SDK calls. Adjust via `FIRECRAWL_REQUEST_DELAY_MS`. HTTP auth/fetch calls are not rate-limited by this utility.
- **ToS:** Authenticated scraping may violate Rakuten's Terms of Service. Use responsibly.
