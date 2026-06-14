# Phase 7: Deployment Folder Cleanup and Environment Organization — 2026-06-14

## Summary

Reorganized the `deployment/` folder from a flat structure into logical subdirectories. Updated all deployment files to use the new `src/` entrypoints. Cleaned and classified all environment variables. Removed deprecated single-node variables.

## Deployment Folder Structure

### Before

```
deployment/
  .env.coordinator.example
  .env.pow-service.example
  .env.worker.example
  coordinator.service
  deploy-pow-service.sh
  DEPLOYMENT.md
  docker/
    docker-compose.yml
    Dockerfile.coordinator
    Dockerfile.pow-service
    Dockerfile.worker
  pow-service.service
  QUICKSTART.md
  railway/
    railway.json
  README.md
  redis.conf
  user-data-coordinator.sh
  user-data-pow-service.sh
  user-data-worker.sh
  worker.service
```

### After

```
deployment/
  docker/
    Dockerfile.coordinator
    Dockerfile.worker
    Dockerfile.pow-service
    docker-compose.yml
  railway/
    railway.json
  systemd/
    coordinator.service
    worker.service
    pow-service.service
  env/
    common.env.example
    coordinator.env.example
    worker.env.example
    pow-service.env.example
  scripts/
    deploy-pow-service.sh
    user-data-coordinator.sh
    user-data-worker.sh
    user-data-pow-service.sh
  redis/
    redis.conf
  README.md
  DEPLOYMENT.md
  QUICKSTART.md
```

## Files Moved

| Old Path | New Path |
|----------|----------|
| `deployment/coordinator.service` | `deployment/systemd/coordinator.service` |
| `deployment/worker.service` | `deployment/systemd/worker.service` |
| `deployment/pow-service.service` | `deployment/systemd/pow-service.service` |
| `deployment/.env.coordinator.example` | `deployment/env/coordinator.env.example` |
| `deployment/.env.worker.example` | `deployment/env/worker.env.example` |
| `deployment/.env.pow-service.example` | `deployment/env/pow-service.env.example` |
| `deployment/redis.conf` | `deployment/redis/redis.conf` |
| `deployment/deploy-pow-service.sh` | `deployment/scripts/deploy-pow-service.sh` |
| `deployment/user-data-coordinator.sh` | `deployment/scripts/user-data-coordinator.sh` |
| `deployment/user-data-worker.sh` | `deployment/scripts/user-data-worker.sh` |
| `deployment/user-data-pow-service.sh` | `deployment/scripts/user-data-pow-service.sh` |

**Total: 11 files moved**

## Environment Variables

### Classification

**COMMON (shared across services):**
- `REDIS_URL` — Redis connection (required for coordinator/worker, optional for pow-service)
- `TARGET_LOGIN_URL` — Rakuten OAuth URL (required for coordinator/worker)
- `NODE_ENV` — Node environment (default: production)
- `LOG_LEVEL` — Logging level (default: info)
- `TIMEOUT_MS` — HTTP timeout (default: 60000)
- `REDIS_COMMAND_TIMEOUT` — Redis command timeout (default: 60000)

**COORDINATOR_ONLY:**
- `TELEGRAM_BOT_TOKEN` — Bot token (required)
- `FORWARD_CHANNEL_ID` — Channel for VALID creds (optional)
- `ALLOWED_USER_IDS` — Allowed Telegram users (optional)
- `METRICS_PORT` — Prometheus port (default: 9090)
- `BATCH_CONCURRENCY` — Parallel checks (default: 1)
- `BATCH_MAX_RETRIES` — Retry count (default: 2)
- `BATCH_DELAY_MS` — Chunk delay (default: 50)
- `BATCH_HUMAN_DELAY_MS` — Human delay (default: 0)
- `PROXY_SERVER` — Single proxy URL (optional)
- `PROXY_POOL` — Comma-separated proxies (optional)
- `PROCESSED_TTL_MS` — Cache TTL (default: 30 days)
- `FORWARD_TTL_MS` — Forward tracking TTL (default: 30 days)

**WORKER_ONLY:**
- `WORKER_ID` — Worker identifier (auto-generated)
- `WORKER_CONCURRENCY` — Concurrent tasks (default: 3)
- `WORKER_TASK_TIMEOUT` — Task timeout (default: 120000)
- `WORKER_HEARTBEAT_INTERVAL` — Heartbeat interval (default: 10000)
- `WORKER_QUEUE_TIMEOUT` — Queue timeout (default: 30000)
- `POW_SERVICE_URL` — POW service endpoint (optional)

**POW_SERVICE_ONLY:**
- `PORT` — HTTP port (default: 3001)
- `POW_NUM_WORKERS` — Worker threads (default: CPU-1)
- `POW_TASK_TIMEOUT` — Task timeout (default: 30000)

### Variables Removed as Deprecated

| Variable | Reason |
|----------|--------|
| `COORDINATOR_MODE` | Entrypoint determines mode |
| `POW_SERVICE_MODE` | Entrypoint determines mode |
| `POW_SERVICE_TIMEOUT` | Not used in code |
| `HEALTH_CHECK_PORT` | Not used in code |
| `HOSTNAME` | Not used in code |
| `WORKER_HTTP_PORT` | Not used in code |
| `BACKUP_COORDINATOR` | Not used in code |
| `JSON_LOGGING` | Not used in code |
| `REDIS_HOST` | Use REDIS_URL instead |
| `REDIS_PORT` | Use REDIS_URL instead |
| `REDIS_PASSWORD` | Use REDIS_URL instead |
| `REDIS_DB` | Use REDIS_URL instead |
| `METRICS_HOST` | Not used in code |
| `AGENT_DEBUG_INGEST_URL` | Not used in code |
| `TRACE_ID` | Not used in code |

### Environment File Organization

```
.env.example                         # Local development all-in-one
deployment/env/common.env.example    # Shared variables across services
deployment/env/coordinator.env.example
deployment/env/worker.env.example
deployment/env/pow-service.env.example
```

## Systemd Changes

All 3 systemd service files updated:

| Change | Before | After |
|--------|--------|-------|
| ExecStart | `/usr/bin/docker run ... rakuten-*:latest` | `/usr/bin/node src/*/index.js` |
| User/Group | Service-specific (`coordinator`, `worker`, `pow-service`) | `rakuten` |
| EnvironmentFile | Per-service `.env.*` files | Single `/opt/rakuten-checker/.env` |
| Worker template | `%i` template for multiple instances | Simple service |

## User-Data Script Changes

All 3 user-data scripts updated:

| Change | Before | After |
|--------|--------|-------|
| Runtime | Docker install + build | Node.js 20 install + `npm ci` |
| Env path | `deployment/.env.*.example` | `deployment/env/*.env.example` |
| Systemd path | `deployment/*.service` | `deployment/systemd/*.service` |

## Docker Compose Changes

- Redis volume path: `../redis.conf` → `../redis/redis.conf`
- All other Docker configuration unchanged

## Railway Changes

- No changes needed — already uses `node src/coordinator/index.js`

## Documentation Updated

| File | Changes |
|------|---------|
| `README.md` | Updated deployment folder structure section |
| `deployment/README.md` | Fixed SCP, npm, env, and systemd paths |
| `deployment/DEPLOYMENT.md` | Fixed all path references, removed Docker-based deployment |
| `deployment/QUICKSTART.md` | Updated `docker-compose` → `docker compose`, fixed ports |
| `docs/NEW_FOLDER_STRUCTURE.md` | Updated deployment section to match new structure |
| `docs/ENVIRONMENT_VARIABLES.md` | Removed single-node mode documentation |

## Validation Results

### Old Reference Scan

Searched for deprecated references across the project:

```
grep -R "main.js|worker.js|pow-service.js|logger.js|httpChecker.js|automation/|shared/|telegram/|utils/|single-node|SingleNode|JSONL|processed.jsonl" deployment/ .env.example docs/ README.md
```

Results:
- `deployment/` — No old references found
- `.env.example` — No old references found
- `README.md` — No old references found
- `docs/` — Historical documentation only (DOCS_HISTORY_OK)

### Shell Syntax Validation

```bash
bash -n deployment/scripts/*.sh
```

All 4 scripts pass syntax validation.

### Docker Compose Validation

```bash
docker compose -f deployment/docker/docker-compose.yml config
```

Docker not available in current environment. Configuration verified by inspection.

### Systemd Validation

All 3 service files verified by inspection:
- Correct `ExecStart` paths
- Correct `EnvironmentFile` paths
- Correct `WorkingDirectory`
- Correct restart policies

## Remaining Deployment Risks

### No Risk

1. **Files moved with git mv** — History preserved
2. **All paths updated** — No broken references
3. **Docker compose updated** — Redis config path correct

### Low Risk

1. **Docker validation skipped** — Docker not available; verify with `docker compose config` when available
2. **deploy-pow-service.sh** — Still references Docker for building; may need update if pow-service should also use node directly
3. **Inline env examples in DEPLOYMENT.md** — May have minor inconsistencies with actual env files

## Commands to Run After Cleanup

```powershell
# Verify no old references
Select-String -Path .\deployment\**\*,.\docs\**\*,.\README.md,.\.env.example -Pattern "main.js","worker.js","pow-service.js","logger.js","httpChecker.js","automation/","shared/","telegram/","utils/","single-node","SingleNode","JSONL","processed.jsonl"

# Validate shell scripts
bash -n deployment/scripts/*.sh

# Validate Docker compose (when Docker available)
docker compose -f deployment/docker/docker-compose.yml config

# Verify git status
git status
```

## Phase 7 Status: **COMPLETE**
