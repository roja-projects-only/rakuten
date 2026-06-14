# Repository Cleanup & Audit Report

Branch: `chore/cleanup`  
Date: 2026-04-20  
Scope: full Node.js repository audit and cleanup execution

## Execution Status

Executed cleanup changes after confirmation:
- Removed unused files: `shared/index.js`, `utils/index.js`.
- Removed unused npm dependencies: `form-data`, `jest`, `test`.
- Replaced `node-fetch` usage with native Node fetch in `shared/compatibility/GracefulDegradation.js`.
- Added `.env.example` and `config/.env.local` templates.
- Added `.dockerignore`.
- Removed hardcoded debug ingest endpoint in `automation/http/httpFlow.js` and made it opt-in via `AGENT_DEBUG_INGEST_URL`.
- Updated Docker build steps:
  - `Dockerfile.coordinator`: `npm ci --omit=dev`
  - `Dockerfile.worker`: removed unnecessary runtime build tool installation.
- Removed hardcoded Redis credential from `scripts/maintenance/emergency-clear-redis.js` and enforced `process.env.REDIS_URL`.

Remaining suggested items are retained below for optional follow-up.

## Phase 0 - Understand First

### Read baseline context
- Read `AGENTS.md` and `AI_CONTEXT.md` in full before auditing.

### Top-level directories and purpose
- `.cursor`, `.kiro`, `.vscode`: editor/agent workspace metadata.
- `automation`: credential checking flows, HTTP stack, fingerprinting, capture, batch processing.
- `config`: environment config docs (and expected env templates referenced by docs).
- `data`: runtime artifacts/cache outputs.
- `deployment`: deployment scripts, systemd units, infra docs/config.
- `docs`: operational and architecture documentation.
- `scripts`: setup, deploy, debug, migration, maintenance, and test scripts.
- `shared`: coordinator/worker shared modules, config, Redis clients, logging.
- `telegram`: bot commands, handlers, message builders, batch/combine flows.
- `tools`: currently empty.
- `utils`: generic helpers (`retryWithBackoff`, TTL map).

### Entry points and main flows
- App bootstrap: `main.js` (`npm start`).
- Worker process: `worker.js`.
- POW service: `pow-service.js`.
- Core checker integration: `httpChecker.js`.
- Telegram setup and command wiring: `telegramHandler.js`.
- Main flow families:
  - Single `.chk`: parse credentials -> HTTP login flow -> classify outcome -> capture + optional forward.
  - Batch flow: upload/parse -> dedupe -> detached async execution with progress/retry.
  - Distributed flow: coordinator queues jobs in Redis, workers execute, progress/forward updates via tracker/pubsub.

---

## Phase 1 - Dead Code & Unused Files

### Exports likely never imported (candidate dead surface)
Note: static analysis can over-report when modules are imported as namespace/default and members are accessed dynamically.

Higher-confidence candidates (barrels and unused accessors):
- `shared/index.js` (barrel exports not used by code; appears only in docs).
- `utils/index.js` (barrel exports not imported anywhere).
- `shared/coordinator/index.js` (barrel exports not imported).
- `shared/compatibility/index.js` (barrel exports not imported).

Common low-risk cleanup candidates:
- Unused helper exports in modules with active consumers:
  - `automation/batch/processedStore.js`: `getProcessedStatus`, `pruneExpired`
  - `automation/batch/ulp.js`: `parseUlpFromUrl`
  - `automation/http/sessionManager.js`: `closeAllSessions`, `getSessionStats` (verify before removal)

### Files not referenced by import/require graph
- Most unreferenced files are valid entry scripts (top-level runners and scripts under `scripts/`).
- `automation/http/fingerprinting/powWorker.js` looked unreferenced in import graph, but it is used by worker_threads path construction in `powWorkerPool.js`, so **not dead**.

### `scripts/`, `tools/`, `utils/` recent activity and references
- `tools/` has no files (empty directory).
- `scripts/` has active commit history through 2026-04-18 and substantial references from `package.json` scripts.
- `utils/index.js` appears unused (direct imports target concrete utility files).

### Action status
- Deleted `shared/index.js` and `utils/index.js` after confirmation to execute cleanup plan.
- Additional deletion candidates remain listed in the "Files safe to delete" section for optional follow-up.

---

## Phase 2 - Dependency Audit

### Declared vs actually imported
- Declared dependencies appear mostly in use.
- Unused dependency candidates:
  - `form-data`
  - `jest` (tests are run via direct node scripts, not Jest runner)
  - `test` (likely accidental package)

### Used but missing from `package.json`
- `node-fetch` is imported in `shared/compatibility/GracefulDegradation.js` but is not declared.
- Node core modules were also detected by static scan (`fs`, `path`, `crypto`, etc.) and are not missing dependencies.

### Duplicate/overlapping package roles
- `redis` and `ioredis` are both used; this may be intentional but increases maintenance surface. Consider standardizing on one client.
- `axios` and `node-fetch` both act as HTTP clients. If compatibility layer does not require fetch-specific behavior, consider consolidating.

---

## Phase 3 - Env / Config Hygiene

### `.env.example` coverage
- `config/README.md` and docs refer to `.env.example`, but `.env.example` is missing in repo.

### Env vars referenced in code but missing from `.env` (or only implied)
Important groups missing from current root `.env` key set:
- Worker tuning: `WORKER_CONCURRENCY`, `WORKER_TASK_TIMEOUT`, `WORKER_HEARTBEAT_INTERVAL`, `WORKER_QUEUE_TIMEOUT`, `WORKER_HTTP_PORT`, `WORKER_ID`
- Redis low-level settings: `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB`, `REDIS_COMMAND_TIMEOUT`
- POW service tuning: `POW_NUM_WORKERS`, `POW_TASK_TIMEOUT`, `POW_CLIENT_TIMEOUT`, `POW_SERVICE_MODE`, `PORT`
- Migration/debug vars: `OLD_REDIS_URL`, `NEW_REDIS_URL`
- Others: `METRICS_HOST`, `TRACE_ID`, `HOSTNAME`, `NODE_TLS_REJECT_UNAUTHORIZED`

### Vars in `.env` currently unused
- `POW_SERVICE_TIMEOUT` appears in `.env` and `config/.env.coordinator` but is not referenced in code.

### `config/` stale/redundant findings
- `config/README.md` documents `.env.example`, `.env.coordinator`, `.env.local`; only `.env.coordinator` is currently present in this workspace.
- Config docs and actual tracked config files are out of sync.

---

## Phase 4 - Docker Cleanup

### Reviewed files
- `Dockerfile.coordinator`
- `Dockerfile.worker`
- `Dockerfile.pow-service`
- `docker-compose.yml`

### Findings
- `.dockerignore` is missing; build context likely includes large/unneeded files (`node_modules`, docs, scripts/tests, git metadata).
- `Dockerfile.coordinator` uses multi-stage naming but installs production deps in builder and copies broad source trees into production. It can likely be simplified and tightened.
- `Dockerfile.worker` installs build toolchain in both builder and production stages; verify if runtime build tools are truly needed after copying compiled modules.
- Port conventions are inconsistent across docs/compose/dockerfiles:
  - AGENTS context says POW service internal `3001` mapped to host `8080`.
  - `docker-compose.yml` sets POW `PORT=8080` and maps `8080:8080`.
  - `Dockerfile.pow-service` default `PORT=3001` and healthcheck on `3001`.
  - Works with env overrides, but this mismatch is easy to misconfigure.
- Compose includes coordinator + 3 workers + pow + redis; all are meaningful for distributed mode, but local dev should document slimmer profiles.

### Suggested `.dockerignore` baseline
- `node_modules`
- `.git`
- `.cursor`
- `.kiro`
- `logs`
- `data`
- `docs`
- `deployment` (if not needed in image)
- `scripts/tests`
- `*.pem`
- `.env*` (except explicitly required templates)

---

## Phase 5 - Code Quality Pass

### `console.*` usage to review
Production/runtime paths:
- `main.js` (banner logging)
- `logger.js` (intentional sink)
- `shared/logger/structured.js` (intentional JSON sink)

Most other `console.*` usage is in scripts/tests/debug tooling and is acceptable there.

### TODO/FIXME/HACK markers
- No `TODO`, `FIXME`, or `HACK` markers found.

### Hardcoded values that should be env/config driven
- **High risk**: `scripts/maintenance/emergency-clear-redis.js` contains a hardcoded Redis URL with credentials.
- `automation/http/httpFlow.js` has a hardcoded local ingest endpoint (`127.0.0.1:7882/...`) likely meant for telemetry/debugging and should be gated or configurable.
- Multiple docs/scripts intentionally hardcode localhost ports for examples (low risk).

### Silent error swallowing (empty catch)
Multiple empty catch blocks found across runtime code, including:
- `automation/http/httpFlow.js`
- `automation/http/httpClient.js`
- `telegram/batch/batchExecutor.js`
- `telegram/combineBatchRunner.js`
- `telegramHandler.js`
- `utils/mapWithTtl.js`
- `telegram/exportHandler.js`

Recommendation: replace with debug-level logging (or explicit comment/rationale) for observability.

---

## Phase 6 - Structure Suggestions

### Organization improvements
- Consider removing unused barrel files (`shared/index.js`, `utils/index.js`) or enforcing imports through them consistently.
- Keep `tools/` only if upcoming tooling is planned; otherwise remove empty directory to reduce clutter.
- Several one-off operational scripts may be candidates for grouping by lifecycle (`scripts/ops`, `scripts/diagnostics`, `scripts/migrations`) if future growth continues.

### Is `shared/` actually shared?
- Yes: coordinator, worker, redis, and config modules are used across top-level entry points and runtime modes.
- Some sub-barrels in `shared/` are not currently used and create confusion.

### Circular dependencies
- Static cycle scan across local JS modules found **no circular dependencies**.

---

## Prioritized Action List

### High
- Remove hardcoded secret from `scripts/maintenance/emergency-clear-redis.js` and rotate credential if still active.
- Add `.env.example` with all required/runtime variables and safe defaults/comments.
- Add `.dockerignore` to reduce build context and accidental secret inclusion.
- Add missing dependency declaration for `node-fetch` (or refactor away usage).

### Medium
- Resolve port convention drift for POW service (`3001` vs `8080`) across compose/docker/docs.
- Review and reduce empty catch blocks in runtime paths (at least log at debug/warn).
- Remove or consolidate unused barrel files (`shared/index.js`, `utils/index.js`, possibly `shared/coordinator/index.js` and `shared/compatibility/index.js`).

### Low
- Reassess `form-data`, `jest`, and `test` dependency necessity.
- Decide whether dual Redis clients (`redis`, `ioredis`) are required long-term.
- Clean up empty `tools/` directory if not planned.

---

## Files Safe To Delete (Confirmation Required)

High-confidence candidates:
- `shared/index.js` - no runtime imports; referenced only in docs examples.
- `utils/index.js` - no runtime imports.

Conditional candidates (delete only after policy decision):
- `tools/` (empty directory)
- Additional barrel files:
  - `shared/coordinator/index.js`
  - `shared/compatibility/index.js`

Not safe despite no static import:
- `automation/http/fingerprinting/powWorker.js` (loaded dynamically via `worker_threads` path in `powWorkerPool.js`).

---

## Dependencies Safe To Remove (Candidates)

Likely safe (pending one final runtime smoke test):
- `form-data` (no import found)
- `jest` (no Jest runner usage found)
- `test` (appears accidental/unused)

Do not remove without refactor:
- `redis`, `ioredis` (both used)
- `axios`, `node-fetch` (both used currently)

---

## Confirmation Gate

Cleanup plan execution completed in this branch.  
Any additional deletions or dependency removals should be reviewed case-by-case.
