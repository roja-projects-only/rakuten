# Firecrawl Local Exploration Utility

Local-only utility for mapping public Rakuten endpoints and exploring authenticated areas via the Firecrawl cloud API. **Not used by production services** (coordinator/worker/pow-service).

## Overview

This utility lives in `src/firecrawl/` (modules) and `scripts/firecrawl/` (executable scripts). It uses the paid Firecrawl cloud API with the `enhanced` residential proxy and JP locale to handle Rakuten's Cloudflare bot protection.

**Workflow:**
1. Map public endpoints (`map-public.js`)
2. Log in with credentials to create a persistent browser profile (`login.js`)
3. Scrape authenticated pages using the saved profile (`scrape-authed.js`, `explore-batch.js`)

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

All scripts support `--dry-run` which prints config and exits without calling the API:

```bash
node scripts/firecrawl/map-public.js --dry-run
node scripts/firecrawl/login.js --dry-run
node scripts/firecrawl/scrape-authed.js --dry-run https://www.rakuten.co.jp
node scripts/firecrawl/explore-batch.js data/firecrawl/test-urls.txt --dry-run
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

### Log in and save profile

```bash
node scripts/firecrawl/login.js [loginUrl] [--email <email>] [--password <pwd>] [--no-2fa] [--force-2fa-pause] [--code <file>]
```

Performs browser-based login via Firecrawl's scrape + interact API, saves a persistent profile server-side. The profile is valid for ~15 minutes — run scrape scripts within that window.

| Flag | Default | Description |
|------|---------|-------------|
| `loginUrl` | `TARGET_LOGIN_URL` | Login page URL |
| `--email` | `TEST_EMAIL` | Rakuten account email |
| `--password` | `TEST_PASSWORD` | Rakuten account password |
| `--no-2fa` | — | Skip 2FA detection and pause entirely |
| `--force-2fa-pause` | — | Skip AI detection, pause unconditionally for 2FA code entry |
| `--code <file>` | — | Use raw Playwright code from file instead of natural language prompt |
| `--dry-run` | — | Print masked config, exit without API call |

**2FA handling:** By default, the script detects 2FA challenges and prompts for the code via stdin. Enter the code from your authenticator app, or press Enter to skip. The 2FA pause has a 5-minute timeout.

**Rate limit note:** The `FIRECRAWL_REQUEST_DELAY_MS` delay applies to all SDK calls including interact. For the login flow (multiple interact calls), consider setting `FIRECRAWL_REQUEST_DELAY_MS=0` to avoid artificial delays:

```bash
FIRECRAWL_REQUEST_DELAY_MS=0 node scripts/firecrawl/login.js
```

### Scrape a single authenticated page

```bash
node scripts/firecrawl/scrape-authed.js <url> [--formats <list>] [--screenshot] [--no-main-content] [--profile <name>]
```

Scrapes a single URL using the saved Firecrawl profile. If no profile metadata exists, falls back to public scrape with a warning.

| Flag | Default | Description |
|------|---------|-------------|
| `url` | (required) | URL to scrape |
| `--formats` | `markdown` | Comma-separated: `markdown`, `html`, `rawHtml`, `links`, `images` |
| `--screenshot` | — | Include screenshot in output |
| `--no-main-content` | — | Extract full page (not just main content) |
| `--profile <name>` | `FIRECRAWL_PROFILE_NAME` | Override profile name |
| `--dry-run` | — | Print config + profile status, exit without API call |

Output: `data/firecrawl/scrape-{slug}-{timestamp}.json`.

### Batch scrape multiple URLs

```bash
node scripts/firecrawl/explore-batch.js <urlsFile> [--formats <list>] [--screenshot] [--concurrency <n>]
```

Scrapes multiple URLs from a text file (one URL per line, `#` comments allowed). Uses the saved profile for authenticated scraping.

| Flag | Default | Description |
|------|---------|-------------|
| `urlsFile` | (required) | File with one URL per line |
| `--formats` | `markdown` | Comma-separated output formats |
| `--screenshot` | — | Include screenshots |
| `--concurrency` | 1 | Number of concurrent scrapes |
| `--dry-run` | — | Read file, count URLs, exit without API call |

Output: individual scrape files + `data/firecrawl/batch-{timestamp}.json` summary.

## Output

All output is written to `data/firecrawl/` (gitignored):

| File pattern | Content |
|-------------|---------|
| `map-{timestamp}.json` | Discovered URLs from map |
| `login-{timestamp}.json` | Login result metadata |
| `profiles/{profileName}.json` | Profile metadata (scrapeId, loginUrl, savedAt) |
| `scrape-{slug}-{timestamp}.json` | Single page scrape result |
| `batch-{timestamp}.json` | Batch scrape summary |

Each output file embeds metadata: `timestamp`, `configHash`, `profileName`, `script`.

## Architecture

```
src/firecrawl/
  config.js     — Env validation, frozen config object, config hash
  client.js     — Singleton Firecrawl SDK client with rate-limit Proxy
  map.js        — mapSite() + mapAndSave() for /v2/map
  auth.js       — loginAndPersist() + loadProfileMetadata() for browser login
  scrape.js     — scrapePage() + scrapeBatch() for /v2/scrape
  README.md     — Pointer to this doc

scripts/firecrawl/
  map-public.js     — Map public endpoints
  login.js          — Login + save profile
  scrape-authed.js  — Scrape single authed page
  explore-batch.js  — Batch scrape from URLs file
```

**Key design decisions:**
- `firecrawl` installed as `devDependency` — keeps it out of production Docker images
- Env vars self-validated in `config.js` (not in production `environment.js`)
- Rate limiting centralized in `client.js` via Proxy (post-call delay)
- Profiles managed by Firecrawl server-side; only metadata stored locally
- Credentials never logged at any level
- `--dry-run` works without API key (runs before validation)

## Limitations

- **Session expiry:** Profiles expire ~15 minutes after login. Re-run `login.js` to refresh.
- **2FA:** Firecrawl cannot solve 2FA automatically. The login script prompts for the code via stdin.
- **Captchas:** No native captcha solving. The `enhanced` proxy avoids most, but hCaptcha/Turnstile may still trigger.
- **Rate limits:** Default 10s delay between calls. Adjust via `FIRECRAWL_REQUEST_DELAY_MS`.
- **ToS:** Authenticated scraping may violate Rakuten's Terms of Service. Use responsibly.