# Deprecation Map — 2026-06-14

All single-node mode related items that must be removed or migrated.

## Single-Node Files

| File | Classification | Action |
|------|---------------|--------|
| `shared/compatibility/SingleNodeMode.js` | REMOVE | Entire file is single-node mode implementation |
| `shared/compatibility/GracefulDegradation.js` | REMOVE | Fallback wrappers for single-node mode |
| `shared/compatibility/index.js` | REMOVE | CompatibilityLayer with single-node detection and fallback |
| `telegram/combineBatchRunner.js` | MIGRATE TO COORDINATION MODE | Contains single-node combine batch execution; must be rewritten for distributed |
| `scripts/setup/fix-coordinator-no-docker.ps1` | REMOVE | Empty file |
| `scripts/setup/fix-coordinator-issue.ps1` | REMOVE | Superseded by simpler alternatives |

## Single-Node Functions

| Function | File | Classification | Action |
|----------|------|---------------|--------|
| `SingleNodeJobQueue` class | `shared/compatibility/SingleNodeMode.js` | REMOVE | In-memory queue implementation |
| `SingleNodeMode.detect()` | `shared/compatibility/SingleNodeMode.js` | REMOVE | Mode detection for deprecated mode |
| `SingleNodeMode.initialize()` | `shared/compatibility/SingleNodeMode.js` | REMOVE | Single-node initialization |
| `SingleNodeMode.createCompatibilityWrapper()` | `shared/compatibility/SingleNodeMode.js` | REMOVE | Mock distributed components |
| `CompatibilityLayer.initializeSingleNodeMode()` | `shared/compatibility/index.js` | REMOVE | Single-node init path |
| `CompatibilityLayer.initializeSingleNodeFallback()` | `shared/compatibility/index.js` | REMOVE | Single-node fallback path |
| `CompatibilityLayer.processBatchLegacy()` | `shared/compatibility/index.js` | REMOVE | Legacy batch processing |
| `isSingleNodeMode()` | `shared/config/environment.js` | REMOVE | Detection function |
| `isDistributedMode()` | `shared/config/environment.js` | REWRITE | Simplify to always return true |
| `getDeploymentMode()` | `shared/config/environment.js` | REWRITE | Remove 'single' return value |
| `validateEnvironment()` mode='single' | `shared/config/environment.js` | REMOVE | Single-node validation path |
| Single-node env validation | `main.js:51-63` | REMOVE | Validates for single-node mode |
| Single-node mode logging | `main.js:140-152` | REMOVE | Logs single-node features |
| Single-node `/stop` handling | `telegramHandler.js:326-371` | REMOVE | Inline batch abort for single-node |
| `isDistributed()` branching | `telegram/batch/batchExecutor.js` | REWRITE | Assume distributed always |
| Single-node combine execution | `telegram/combineBatchRunner.js` | REWRITE | Rewrite for distributed |

## Single-Node Assumptions

| Assumption | Where | Action |
|------------|-------|--------|
| Redis may not be available | `shared/compatibility/`, `main.js` | REMOVE — Redis is always required |
| JSONL fallback for dedup | `automation/batch/processedStore.js` | REMOVE — Redis-only |
| In-memory job queue | `shared/compatibility/SingleNodeMode.js` | REMOVE — Redis queue only |
| Inline batch execution | `telegram/batch/batchExecutor.js`, `telegram/combineBatchRunner.js` | REMOVE — All batches go through Redis queue |
| Mode auto-detection | `shared/config/environment.js`, `shared/compatibility/index.js` | REMOVE — Each service knows its mode |

## Single-Node Environment Variables

| Variable | Classification | Action |
|----------|---------------|--------|
| (none exclusively single-node) | — | Mode is determined by absence of `REDIS_URL` |

Note: The single-node mode is triggered by NOT setting `REDIS_URL`. In the rewrite, `REDIS_URL` is always required.

## Single-Node Package Scripts

| Script | Classification | Action |
|--------|---------------|--------|
| (none exclusively single-node) | — | All scripts work in coordination mode |

## Single-Node Docker References

| Reference | File | Classification | Action |
|-----------|------|---------------|--------|
| Single-node fallback in compose | `docker-compose.yml` | NEUTRAL | No changes needed (compose is already distributed) |
| Railway single-node deploy | `railway.json` | REFERENCE ONLY | Railway deploys coordinator only |

## Single-Node Deployment References

| Reference | File | Classification | Action |
|-----------|------|---------------|--------|
| Local dev with JSONL | `deployment/QUICKSTART.md` | REMOVE | Update docs for distributed-only |
| Single-node Docker setup | `deployment/README.md` | REMOVE | Update docs for distributed-only |
| `config/.env.local` | `config/.env.local` | REMOVE | Local dev config with single-node assumptions |

## Summary

| Category | Count | Action |
|----------|-------|--------|
| Files to REMOVE | 6 | Delete entirely |
| Files to MIGRATE | 1 | Rewrite for coordination mode |
| Functions to REMOVE | 10 | Delete from codebase |
| Functions to REWRITE | 4 | Simplify for coordination-only |
| Assumptions to REMOVE | 5 | Update code to assume distributed |
| Env vars to change | 1 | Make `REDIS_URL` required |
| Docs to update | 2 | Remove single-node references |
