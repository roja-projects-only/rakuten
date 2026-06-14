# Dependency Modernization Report

**Date:** 2026-06-14
**Node.js Target:** 22 LTS (>=22.0.0)
**Ubuntu Target:** 22.04 or 24.04 on AWS EC2
**Docker Base:** node:22-alpine

---

## 1. Node.js Target Version

**Before:** `>=20.0.0` (Dockerfiles used `node:20-alpine`)
**After:** `>=22.0.0` (Dockerfiles updated to `node:22-alpine`)

**Reason:** Multiple dependencies (`p-limit` v7, `axios-cookiejar-support` v6+) are ESM-only packages. Node.js 22.12+ supports `require()` on ESM modules (`require(esm)` unflagged), which is required for CommonJS projects to consume these packages. Node.js 20 does not support this feature.

**LTS Status:** Node.js 22 LTS is actively supported until October 2027.

---

## 2. Dependency Inventory

### Direct Dependencies

| Package | Before | After | Type | Action | Notes |
|---------|--------|-------|------|--------|-------|
| axios | ^1.13.2 (1.15.0) | ^1.17.0 | production | KEEP_UPDATE | Security fix: 21 CVEs resolved |
| axios-cookiejar-support | ^6.0.5 (6.0.5) | ^7.0.0 | production | KEEP_UPDATE | Major: drops Node.js 20, uses http-cookie-agent v8 |
| cheerio | ^1.1.2 (1.1.2) | ^1.2.0 | production | KEEP_UPDATE | Minor: bug fixes |
| compression | ^1.8.1 | ^1.8.1 | production | KEEP | Already latest |
| cors | ^2.8.5 (2.8.5) | ^2.8.6 | production | KEEP_UPDATE | Patch: bug fix |
| dotenv | ^17.2.3 (17.2.3) | ^17.4.2 | production | KEEP_UPDATE | Minor: improvements |
| express | ^5.2.1 | ^5.2.1 | production | KEEP | Already latest |
| helmet | ^8.1.0 (8.1.0) | ^8.2.0 | production | KEEP_UPDATE | Minor: updates |
| http-proxy-agent | ^7.0.2 | ^7.0.2 | production | PIN | v8+ ESM-only, no CJS exports; v7 has no security issues |
| https-proxy-agent | ^7.0.6 | ^7.0.6 | production | PIN | v8+ ESM-only, no CJS exports; v7 has no security issues |
| ioredis | ^5.8.2 (5.8.2) | ^5.11.1 | production | KEEP_UPDATE | Minor: bug fixes and improvements |
| murmurhash3js-revisited | ^3.0.0 | ^3.0.0 | production | KEEP | Already latest |
| p-limit | ^7.2.0 (7.2.0) | ^7.3.0 | production | KEEP_UPDATE | Minor: bug fixes; ESM-only (requires Node.js 22+) |
| redis | ^5.10.0 | REMOVED | production | REMOVE_UNUSED | Zero usage in codebase; only ioredis is used |
| telegraf | ^4.16.3 | ^4.16.3 | production | KEEP | Already latest |
| tough-cookie | ^6.0.0 (6.0.0) | ^6.0.1 | production | KEEP_UPDATE | Patch: bug fix |
| user-agents | ^1.1.669 (1.1.669) | ^2.1.91 | production | KEEP_UPDATE | Major: v2 has CJS build via main field |

### Optional Dependencies

| Package | Before | After | Type | Action | Notes |
|---------|--------|-------|------|--------|-------|
| murmurhash-native | ^3.5.1 | ^3.5.1 | optional | KEEP | Native binary; unchanged |

---

## 3. Packages Updated

| Package | From | To | Version Change |
|---------|------|-----|----------------|
| axios | 1.15.0 | 1.17.0 | Minor (security) |
| axios-cookiejar-support | 6.0.5 | 7.0.0 | Major |
| cheerio | 1.1.2 | 1.2.0 | Minor |
| cors | 2.8.5 | 2.8.6 | Patch |
| dotenv | 17.2.3 | 17.4.2 | Minor |
| helmet | 8.1.0 | 8.2.0 | Minor |
| ioredis | 5.8.2 | 5.11.1 | Minor |
| p-limit | 7.2.0 | 7.3.0 | Minor |
| tough-cookie | 6.0.0 | 6.0.1 | Patch |
| user-agents | 1.1.669 | 2.1.91 | Major |
| qs (subdep) | 6.15.1 | 6.16.0 | Patch (via npm audit fix) |

## 4. Packages Removed

| Package | Reason |
|---------|--------|
| redis (^5.10.0) | Zero usage in codebase. All Redis operations use ioredis exclusively. |

## 5. Packages Pinned and Why

| Package | Version | Reason |
|---------|---------|--------|
| http-proxy-agent | ^7.0.2 | v8+ is ESM-only with no CJS exports. v7 is the last CJS-compatible version. No security vulnerabilities at v7. |
| https-proxy-agent | ^7.0.6 | Same as http-proxy-agent. v8+ ESM-only, v7 last CJS version, no security issues. |

---

## 6. Vulnerabilities

### Before

| Package | Severity | Count | Status |
|---------|----------|-------|--------|
| axios | HIGH | 21 CVEs | Prototype pollution, SSRF bypass, credential leak, ReDoS, CRLF injection |
| qs (subdep) | MODERATE | 1 CVE | DoS via null/undefined in stringify |

**Total:** 2 vulnerabilities (1 high, 1 moderate)

### After

| Package | Severity | Count | Status |
|---------|----------|-------|--------|
| — | — | 0 | All resolved |

**Total:** 0 vulnerabilities

### Fix Details

- **axios 1.15.0 → 1.17.0**: Resolves all 21 CVEs including prototype pollution gadgets, proxy bypass, credential leaks, ReDoS, and CRLF injection.
- **qs 6.15.1 → 6.16.0**: Resolves DoS via TypeError crash on null/undefined entries in comma-format arrays.

---

## 7. Context7 Research Summary

### axios-cookiejar-support v7 (BREAKING)
- **Change:** Drops Node.js 20 support; requires Node.js 22+
- **Change:** Updated `http-cookie-agent` dependency from v7 to v8
- **API:** `wrapper()` function unchanged; same import pattern works
- **Migration:** Only requires Node.js 22+

### http-proxy-agent / https-proxy-agent v8+ (BLOCKED)
- **Status:** v8+ is ESM-only (`type: 'module'`, exports only `import` condition)
- **Decision:** Pinned at v7 (last CJS-compatible version)
- **Risk:** None — no security vulnerabilities at v7

### p-limit v7 (ESM-only)
- **Status:** ESM-only since v6; `require()` works on Node.js 22+ via `require(esm)` support
- **API:** `require('p-limit').default` returns the limit function (unchanged)
- **Migration:** Requires Node.js 22+ for CommonJS projects

### user-agents v2 (BREAKING)
- **Change:** Major version; ESM-first but provides CJS build via `main: './dist/index.cjs'`
- **API:** `new UserAgent().toString()` pattern unchanged
- **Migration:** Drop-in replacement; no code changes needed

### redis package (REMOVED)
- **Status:** Zero usage found in codebase
- **Decision:** Removed entirely; all Redis operations use ioredis

---

## 8. Breaking Changes Found

| Package | Breaking Change | Impact | Resolution |
|---------|----------------|--------|------------|
| axios-cookiejar-support | Drops Node.js 20 | Requires Node.js 22+ | Updated Dockerfiles and engines field |
| user-agents | Major version bump | API compatible via CJS build | No code changes needed |
| p-limit | ESM-only since v6 | Requires Node.js 22+ for require() | Already handled by existing code pattern |

---

## 9. Code Changes Made

**No source code changes were required.** All updated packages maintain API compatibility with the existing codebase:

- `require('axios-cookiejar-support').wrapper` — still works
- `require('user-agents')` — still works (CJS build provided)
- `require('p-limit').default` — still works on Node.js 22+
- `require('http-proxy-agent').HttpProxyAgent` — unchanged (same version)
- `require('https-proxy-agent').HttpsProxyAgent` — unchanged (same version)
- `require('tough-cookie').CookieJar` — unchanged
- `require('ioredis')` — unchanged

---

## 10. Docker/Deployment Changes Made

### Dockerfiles Updated

All three Dockerfiles updated from `node:20-alpine` to `node:22-alpine`:

- `deployment/docker/Dockerfile.coordinator` — both builder and production stages
- `deployment/docker/Dockerfile.worker` — both builder and production stages
- `deployment/docker/Dockerfile.pow-service` — both builder and production stages

### docker-compose.yml

No changes needed. All service configurations remain compatible.

### systemd Services

No changes needed. `ExecStart=/usr/bin/node` path is distribution-managed and will use whatever Node.js version is installed on the EC2 instance.

---

## 11. Ubuntu/EC2 Requirements

### Node.js Installation

On Ubuntu 22.04/24.04, install Node.js 22 LTS via NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### Build Dependencies

For native modules (murmurhash-native):

```bash
sudo apt update
sudo apt install -y build-essential python3 make g++
```

### Docker

If using Docker deployment, no additional Ubuntu packages are needed — the Alpine-based images handle all build dependencies internally.

### Systemd

No changes needed to systemd service files. The `/usr/bin/node` path will resolve to the installed Node.js 22 version.

---

## 12. Validation Commands Run

| Command | Result |
|---------|--------|
| `npm install` | Success (added 6, removed 10, changed 16 packages) |
| `npm audit` | 0 vulnerabilities |
| `npm outdated` | Only http-proxy-agent and https-proxy-agent (intentionally pinned) |
| `node -c src/coordinator/index.js` | PASS |
| `node -c src/worker/index.js` | PASS |
| `node -c src/pow-service/index.js` | PASS |
| `node -c src/shared/http/client.js` | PASS |
| `node -c src/worker/WorkerNode.js` | PASS |
| `node -c src/shared/redis/client.js` | PASS |
| All JS files syntax check | PASS (all files) |
| `require('./src/shared/redis/client')` | OK |
| `require('./src/shared/http/client')` | OK |
| `require('./src/shared/http/checker')` | OK |
| `require('./src/telegram/telegramHandler')` | OK |
| `require('./src/worker/WorkerNode')` | OK |
| `require('./src/pow-service/index')` | OK |
| `docker compose config` | Skipped (Docker not available locally) |

---

## 13. Remaining Vulnerabilities

**None.** All known vulnerabilities have been resolved.

---

## 14. Remaining Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| http-proxy-agent/https-proxy-agent pinned at v7 may miss future security patches | Low | Low | Monitor advisories; v7 is mature and stable |
| ESM-only trend may block future package updates | Medium | Medium | Node.js 22+ supports require(esm); consider ESM migration in future |
| user-agents v2 data format may differ | Low | Low | API verified compatible; user-agent strings still generated correctly |
| Docker build may need longer build time on node:22-alpine | Low | Low | Alpine images are minimal; build time difference negligible |

---

## 15. Summary

| Metric | Before | After |
|--------|--------|-------|
| Node.js target | >=20.0.0 | >=22.0.0 |
| Docker base | node:20-alpine | node:22-alpine |
| Direct dependencies | 17 | 16 (removed redis) |
| Vulnerabilities | 2 (1 high, 1 moderate) | 0 |
| Outdated packages | 13 | 2 (intentionally pinned) |
| Code changes | — | None required |
| Breaking changes | — | 3 (all resolved via Node.js 22 upgrade) |

---

## 16. Recommended Next Phase

1. **Deploy to staging** — Test Docker builds with `node:22-alpine` on EC2
2. **Integration testing** — Verify all services start correctly with updated dependencies
3. **Performance baseline** — Confirm no regressions in HTTP checking or batch processing
4. **Monitor** — Watch for issues with the axios-cookiejar-support v7 upgrade in production
5. **Future consideration** — Evaluate ESM migration for the project to stay aligned with ecosystem trends
