# Phase 5: Root and Deployment Plan — 2026-06-14

## Current Root Inventory

### Directories

| Directory | Purpose | Status |
|-----------|---------|--------|
| `src/` | New modular source code (coordinator, worker, pow-service, shared, telegram) | KEEP |
| `docs/` | Project documentation and migration records | KEEP |
| `deployment/` | Systemd services, user-data scripts, env examples, redis.conf | KEEP |
| `scripts/` | Deploy, test, maintenance, debug, migration scripts | KEEP |
| `data/` | Runtime data (processed creds, logs) — gitignored | KEEP |
| `node_modules/` | npm dependencies — gitignored | KEEP |
| `automation/` | Old source code — now bridges to `src/shared/` | BRIDGE — DELETE IN PHASE 6 |
| `shared/` | Old coordinator/worker/compatibility — now bridges to `src/` | BRIDGE — DELETE IN PHASE 6 |
| `telegram/` | Old telegram handlers — now bridges to `src/telegram/` | BRIDGE — DELETE IN PHASE 6 |
| `utils/` | Old utility modules — now bridges to `src/shared/utils/` | BRIDGE — DELETE IN PHASE 6 |

### Root Files

| File | Purpose | Status |
|------|---------|--------|
| `main.js` | Thin bridge → `src/coordinator` | BRIDGE — DELETE IN PHASE 6 |
| `worker.js` | Thin bridge → `src/worker` | BRIDGE — DELETE IN PHASE 6 |
| `pow-service.js` | Thin bridge → `src/pow-service` | BRIDGE — DELETE IN PHASE 6 |
| `telegramHandler.js` | Thin bridge → `src/telegram/telegramHandler` | BRIDGE — DELETE IN PHASE 6 |
| `httpChecker.js` | Thin bridge → `src/shared/http/checker` | BRIDGE — DELETE IN PHASE 6 |
| `logger.js` | Thin bridge → `src/shared/logger` | BRIDGE — DELETE IN PHASE 6 |
| `Dockerfile.coordinator` | Docker build for coordinator service | MOVE TO `deployment/docker/` |
| `Dockerfile.worker` | Docker build for worker service | MOVE TO `deployment/docker/` |
| `Dockerfile.pow-service` | Docker build for pow-service | MOVE TO `deployment/docker/` |
| `docker-compose.yml` | Multi-service orchestration | MOVE TO `deployment/docker/` |
| `railway.json` | Railway deployment config | MOVE TO `deployment/railway/` |
| `package.json` | npm project config and scripts | KEEP AT ROOT |
| `package-lock.json` | npm dependency lock file | KEEP AT ROOT |
| `.env` | Environment variables (gitignored) | KEEP AT ROOT |
| `.env.example` | Environment template | KEEP AT ROOT |
| `.gitignore` | Git ignore rules | KEEP AT ROOT |
| `.dockerignore` | Docker ignore rules | KEEP AT ROOT |
| `README.md` | Project documentation | KEEP AT ROOT |
| `AGENTS.md` | Agent instructions | KEEP AT ROOT |
| `AI_CONTEXT.md` | Architecture context | KEEP AT ROOT |
| `CLEANUP_REPORT.md` | Historical cleanup notes | KEEP AT ROOT (docs only) |
| `debug-connection.ps1` | Debug utility | DELETE NOW |
| `ssh-logs.bat` | SSH debug utility | DELETE NOW |

## Recommended Final Root Structure

```
rakuten/
├── src/                          # Main source code
│   ├── coordinator/              # Coordinator service
│   ├── worker/                   # Worker service
│   ├── pow-service/              # POW service
│   ├── shared/                   # Shared modules
│   └── telegram/                 # Telegram handlers
├── docs/                         # Documentation
├── deployment/                   # Deployment configuration
│   ├── docker/                   # Docker files
│   │   ├── Dockerfile.coordinator
│   │   ├── Dockerfile.worker
│   │   ├── Dockerfile.pow-service
│   │   └── docker-compose.yml
│   ├── railway/                  # Railway config
│   │   └── railway.json
│   ├── redis.conf                # Redis config
│   ├── *.service                 # Systemd services
│   ├── *.sh                      # User-data scripts
│   └── *.example                 # Env templates
├── scripts/                      # Scripts
│   ├── deploy/                   # Deployment scripts
│   ├── tests/                    # Test scripts
│   ├── maintenance/              # Maintenance scripts
│   ├── debug/                    # Debug scripts
│   └── migration/                # Migration scripts
├── data/                         # Runtime data (gitignored)
├── package.json                  # npm config
├── package-lock.json             # npm lock
├── .env                          # Environment (gitignored)
├── .env.example                  # Environment template
├── .gitignore                    # Git rules
├── .dockerignore                 # Docker rules
├── README.md                     # Project docs
├── AGENTS.md                     # Agent instructions
└── AI_CONTEXT.md                 # Architecture context
```

## Docker Organization

### Files to Move

| Current Path | New Path |
|--------------|----------|
| `Dockerfile.coordinator` | `deployment/docker/Dockerfile.coordinator` |
| `Dockerfile.worker` | `deployment/docker/Dockerfile.worker` |
| `Dockerfile.pow-service` | `deployment/docker/Dockerfile.pow-service` |
| `docker-compose.yml` | `deployment/docker/docker-compose.yml` |

### Dockerfile Updates Required

All Dockerfiles need:
1. Update `CMD` to use `src/` entrypoints
2. Update `COPY` commands to copy `src/` directory
3. Remove copies of old root files (`main.js`, `worker.js`, `logger.js`, etc.)
4. Remove copies of old directories (`shared/`, `telegram/`, `automation/`, `utils/`)

### docker-compose.yml Updates Required

1. Update `dockerfile` paths to `deployment/docker/Dockerfile.*`
2. Update service commands to use `src/` entrypoints
3. Update healthcheck commands for new paths
4. Update volume mounts if needed

## Railway Organization

### Files to Move

| Current Path | New Path |
|--------------|----------|
| `railway.json` | `deployment/railway/railway.json` |

### railway.json Updates Required

1. Update `startCommand` to `node src/coordinator/index.js`

## package.json Script Updates

### Scripts to Update

| Script | Current | New |
|--------|---------|-----|
| `start` | `node main.js` | `node src/coordinator/index.js` |
| `dev` | `node main.js` | `node src/coordinator/index.js` |
| `start:pow-service` | `node pow-service.js` | `node src/pow-service/index.js` |

### Scripts to Add

| Script | Command | Purpose |
|--------|---------|---------|
| `start:coordinator` | `node src/coordinator/index.js` | Explicit coordinator start |
| `start:worker` | `node src/worker/index.js` | Worker start |

### Scripts to Keep

All `test:*`, `verify:*`, and `update:*` scripts reference files in `scripts/` directory and should be kept as-is.

## Deployment Scripts

### Scripts to Update

| Script | Update Required |
|--------|-----------------|
| `scripts/deploy/update-instance.js` | Update Dockerfile paths to `deployment/docker/` |

### Scripts to Keep

All other scripts in `scripts/deploy/`, `scripts/tests/`, `scripts/maintenance/`, `scripts/debug/`, and `scripts/migration/` should be kept as-is.

## Bridge Removal Strategy (Phase 6)

### Bridges Safe to Remove After Phase 5

Once Docker/package/deployment use `src/` paths directly:

**Root files:**
- `main.js` — no longer needed
- `worker.js` — no longer needed
- `pow-service.js` — no longer needed
- `telegramHandler.js` — no longer needed
- `httpChecker.js` — no longer needed
- `logger.js` — no longer needed

**Old directories:**
- `automation/` — all files are bridges to `src/shared/`
- `shared/` — all files are bridges to `src/`
- `telegram/` — all files are bridges to `src/telegram/`
- `utils/` — all files are bridges to `src/shared/utils/`

### Bridges to Keep Temporarily

None — all bridges can be removed once Docker/package/deployment are updated.

## Risks

### Low Risk

1. **Docker context paths** — Moving Dockerfiles to `deployment/docker/` requires updating `context` in docker-compose.yml to `../..` (project root).

2. **Railway config** — If Railway is actively used, moving `railway.json` may break deployment. Verify Railway usage first.

3. **Test scripts** — Some test scripts may import from old paths. These are in `scripts/tests/` and don't affect runtime.

### No Risk

4. **Root bridges** — Safe to remove after Docker/package/deployment updated.

5. **Old directories** — Safe to remove after Docker/package/deployment updated.

## Phase 5 Changes

### Safe Changes (Implement Now)

1. Move Docker files to `deployment/docker/`
2. Update Dockerfiles to use `src/` entrypoints
3. Update docker-compose.yml for new paths
4. Update package.json scripts
5. Update railway.json
6. Update deployment scripts
7. Delete debug utilities (`debug-connection.ps1`, `ssh-logs.bat`)

### Deferred to Phase 6

1. Delete root bridge files (`main.js`, `worker.js`, etc.)
2. Delete old directories (`automation/`, `shared/`, `telegram/`, `utils/`)
3. Clean up test scripts referencing old paths

## Validation

After Phase 5 changes:

1. Verify Docker builds work with new paths
2. Verify docker-compose.yml is valid
3. Verify package.json scripts work
4. Verify no runtime code references old root files
5. Run syntax checks on changed files
