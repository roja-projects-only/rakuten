# Testing Guide

## Local Full-Flow Test (Single-Process Harness)

The local full-flow test (`scripts/test-full-flow.js`) exercises the complete credential-check pipeline in a single local process using real production modules — no mocking, no external services, no Docker required.

**What it tests:**
1. Environment loading (`.env`)
2. Redis connectivity (optional — used for result storage if available)
3. Simulated coordinator job creation
4. Worker task execution via `processTaskDirect()`
5. PoW/CRES computation (internal modules, automatic local fallback)
6. HTTP credential check flow (navigate → email → password → outcome)
7. Account data capture (if VALID)

**What it does NOT test:**
- Telegram bot
- Coordinator/worker HTTP servers
- Distributed queue (Redis pub/sub)
- POW service HTTP API
- AWS infrastructure or multi-instance coordination

**Usage:**
```bash
# Basic — requires TARGET_LOGIN_URL in .env, prompts for credentials
npm run test:flow
# or
npm run smoke:local

# With inline credentials
npm run test:flow -- --email user@example.com --password secret
```

**Required env:** `TARGET_LOGIN_URL` (from `.env`)

**Optional env:** `REDIS_URL`, `POW_SERVICE_URL`, `PROXY_SERVER`, `TIMEOUT_MS`, `LOG_LEVEL`

This harness is the fastest way to validate changes to the shared modules (HTTP flow, POW, capture) without starting any infrastructure. It is a test-only tool — not a production mode.

---

## Integration Tests

The integration test suite exercises the distributed architecture with real Redis, coordinator, worker, and POW service components.

```bash
# Run all integration tests
npm run test:integration

# Specific integration tests
npm run test:e2e-batch            # End-to-end batch processing
npm run test:coordinator-failover # Coordinator crash recovery
npm run test:worker-crash          # Worker crash recovery
npm run test:deduplication        # Cross-batch deduplication
npm run test:pow-degradation      # POW service fallback behavior
npm run test:proxy-health          # Proxy rotation health checks
npm run test:pow-integration      # POW service client + service integration
```

Integration test scripts live in `scripts/tests/`. They require a local Redis instance and the appropriate environment configuration.

---

## Config System Tests

### Quick Tests (Local)

```bash
# Schema validation + Redis ops + pub/sub
npm run test:config

# Deployment smoke test (loads modules, reads values from env/defaults)
npm run verify:config
```

### Via Telegram

```
/config              — List all settings grouped by category
/config get <KEY>    — Get details for a specific key
/config set <KEY> <VALUE> — Update a setting (propagates via pub/sub)
/config reset <KEY>  — Revert to env/default
```

**Hot-reload test:** Start a batch, then change `BATCH_CONCURRENCY` via `/config set` — the next batch chunk picks it up without restart.

### Troubleshooting

**Config service not initialized:** Check `REDIS_URL`, verify Redis connectivity (`redis-cli ping`), check logs for `"config service"`.

**Changes not propagating:** Verify pub/sub subscription in logs, monitor `redis-cli SUBSCRIBE config_updates`.

**Values reverting after restart:** Expected. Redis values persist; env values reset. Use `/config set` for persistent changes.
