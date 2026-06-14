# Documentation Organization Report

**Date:** 2026-06-14  
**Scope:** Full documentation reorganization after in-place rewrite

---

## 1. Markdown Inventory

**Total files found:** 30 markdown files

### Root Level (3 files)
- `AGENTS.md` — AI agent playbook (UPDATED)
- `AI_CONTEXT.md` — Architecture context (UPDATED)
- `README.md` — Project documentation (UPDATED)

### docs/ (9 active files)
- `README.md` — Documentation index (NEW)
- `ARCHITECTURE.md` — System architecture (NEW)
- `SERVICES.md` — Service responsibilities (NEW)
- `SHARED_MODULES.md` — Shared module reference (NEW)
- `ENVIRONMENT.md` — Environment variables (RENAMED from ENVIRONMENT_VARIABLES.md)
- `DEPLOYMENT.md` — Deployment guide (MOVED from deployment/DEPLOYMENT.md)
- `QUICKSTART.md` — Local dev setup (MOVED from deployment/QUICKSTART.md)
- `POW_SERVICE_DEPLOYMENT.md` — POW deployment (MOVED from deployment/README.md)
- `AWS_SETUP.md` — AWS walkthrough (RENAMED from AWS_SETUP_GUIDE.md)
- `CONFIG_SYSTEM.md` — Config feature docs (RENAMED from CONFIG_FEATURE_SUMMARY.md)
- `POW_SERVICE.md` — POW integration (RENAMED from POW_SERVICE_INTEGRATION.md)
- `OPERATIONS.md` — Quick update guide (RENAMED from QUICK_UPDATE.md)
- `TESTING.md` — Config testing (RENAMED from TESTING_CONFIG.md)

### docs/archive/rewrite/ (7 files)
- `phase-2-shared-migration.md` (MOVED from docs/PHASE_2_SHARED_MIGRATION.md)
- `phase-3-service-migration.md` (MOVED from docs/PHASE_3_SERVICE_MIGRATION.md)
- `phase-4-deprecated-cleanup.md` (MOVED from docs/PHASE_4_DEPRECATED_CLEANUP.md)
- `phase-5-root-deployment-plan.md` (MOVED from docs/PHASE_5_ROOT_AND_DEPLOYMENT_PLAN.md)
- `phase-6-final-cleanup.md` (MOVED from docs/PHASE_6_FINAL_CLEANUP.md)
- `phase-7-deployment-env-cleanup.md` (MOVED from docs/PHASE_7_DEPLOYMENT_ENV_CLEANUP.md)
- `phase-7-post-rewrite-verification.md` (MOVED from docs/PHASE_7_POST_REWRITE_VERIFICATION.md)

### docs/archive/legacy/ (6 files)
- `old-cleanup-report.md` (MOVED from CLEANUP_REPORT.md)
- `deprecated-audit.md` (MOVED from docs/AUDIT_CURRENT_WORKSPACE.md)
- `deprecated-cleanup-plan.md` (MOVED from docs/CLEANUP_AND_REWRITE_PLAN.md)
- `deprecated-deprecation-map.md` (MOVED from docs/DEPRECATION_MAP.md)
- `deprecated-folder-structure.md` (MOVED from docs/NEW_FOLDER_STRUCTURE.md)
- `deprecated-rewrite-foundation.md` (MOVED from docs/REWRITE_FOUNDATION.md)

### scripts/ (3 files)
- `debug/README.md` — Debug scripts docs (KEPT)
- `deploy/README.md` — Deployment scripts docs (KEPT)
- `maintenance/README.md` — Maintenance scripts docs (KEPT)

### data/processed/ (2 files)
- `PROXY_COOKIE_PROBLEM.md` — Proxy cookie issue (KEPT, data file)
- `sample_order-history.md` — Sample order history (KEPT, data file)

---

## 2. Files Moved

| File | From | To |
|------|------|-----|
| PHASE_2_SHARED_MIGRATION.md | docs/ | docs/archive/rewrite/phase-2-shared-migration.md |
| PHASE_3_SERVICE_MIGRATION.md | docs/ | docs/archive/rewrite/phase-3-service-migration.md |
| PHASE_4_DEPRECATED_CLEANUP.md | docs/ | docs/archive/rewrite/phase-4-deprecated-cleanup.md |
| PHASE_5_ROOT_AND_DEPLOYMENT_PLAN.md | docs/ | docs/archive/rewrite/phase-5-root-deployment-plan.md |
| PHASE_6_FINAL_CLEANUP.md | docs/ | docs/archive/rewrite/phase-6-final-cleanup.md |
| PHASE_7_DEPLOYMENT_ENV_CLEANUP.md | docs/ | docs/archive/rewrite/phase-7-deployment-env-cleanup.md |
| PHASE_7_POST_REWRITE_VERIFICATION.md | docs/ | docs/archive/rewrite/phase-7-post-rewrite-verification.md |
| CLEANUP_REPORT.md | root | docs/archive/legacy/old-cleanup-report.md |
| AUDIT_CURRENT_WORKSPACE.md | docs/ | docs/archive/legacy/deprecated-audit.md |
| CLEANUP_AND_REWRITE_PLAN.md | docs/ | docs/archive/legacy/deprecated-cleanup-plan.md |
| DEPRECATION_MAP.md | docs/ | docs/archive/legacy/deprecated-deprecation-map.md |
| NEW_FOLDER_STRUCTURE.md | docs/ | docs/archive/legacy/deprecated-folder-structure.md |
| REWRITE_FOUNDATION.md | docs/ | docs/archive/legacy/deprecated-rewrite-foundation.md |
| DEPLOYMENT.md | deployment/ | docs/DEPLOYMENT.md |
| QUICKSTART.md | deployment/ | docs/QUICKSTART.md |
| README.md | deployment/ | docs/POW_SERVICE_DEPLOYMENT.md |

**Total: 16 files moved**

---

## 3. Files Merged

No files were merged. Existing docs were preserved with renames.

---

## 4. Files Archived

| File | Destination |
|------|-------------|
| 7 phase migration docs | docs/archive/rewrite/ |
| 6 legacy docs | docs/archive/legacy/ |

**Total: 13 files archived**

---

## 5. Files Deleted

No files were deleted.

---

## 6. New Docs Created

| File | Purpose |
|------|---------|
| docs/README.md | Documentation index routing to all docs |
| docs/ARCHITECTURE.md | System architecture, data flow, service boundaries |
| docs/SERVICES.md | Service responsibilities and configuration |
| docs/SHARED_MODULES.md | Shared module reference |

**Total: 4 new files created**

---

## 7. AGENTS.md Changes

- Removed "Single-node: processes batches inline." from Modes section
- Updated `docs/AWS_SETUP_GUIDE.md` reference to `docs/AWS_SETUP.md`

---

## 8. AI_CONTEXT.md Decision

**Decision:** Keep `AI_CONTEXT.md` at root.

**Rationale:**
- Referenced by `AGENTS.md` line 61
- Contains deep architecture reference that complements `AGENTS.md`
- Moving would break cross-references
- Oracle review confirmed root files must stay

**Changes made:**
- Removed "Single-node: `.chk` and batches run inline." from Modes section
- Updated `docs/ENVIRONMENT_VARIABLES.md` reference to `docs/ENVIRONMENT.md`
- Updated `shared/coordinator/ChannelForwarder` reference to `src/coordinator/ChannelForwarder`

---

## 9. README.md Changes

- Updated "Developer docs" section to point to `docs/README.md` index

---

## 10. Deployment Docs Update Summary

- Moved 3 deployment prose docs from `deployment/` to `docs/`
- `deployment/` now contains only artifacts (Dockerfiles, systemd units, env templates, scripts)
- Updated cross-references in moved docs

---

## 11. Stale Reference Scan Results

### Fixed Stale References

| File | Line | Old Reference | New Reference |
|------|------|---------------|---------------|
| AGENTS.md | 11 | "Single-node: processes batches inline." | Removed |
| AI_CONTEXT.md | 48 | "Single-node: `.chk` and batches run inline." | Removed |
| AI_CONTEXT.md | 108 | `shared/coordinator/ChannelForwarder` | `src/coordinator/ChannelForwarder` |
| CONFIG_SYSTEM.md | 6 | `shared/config/configSchema.js` | `src/shared/config/configSchema.js` |
| CONFIG_SYSTEM.md | 12 | `shared/config/configService.js` | `src/shared/config/configService.js` |
| CONFIG_SYSTEM.md | 18 | `telegram/configHandler.js` | `src/telegram/configHandler.js` |
| CONFIG_SYSTEM.md | 32 | `shared/coordinator/ProxyPoolManager.js` | `src/coordinator/ProxyPoolManager.js` |
| CONFIG_SYSTEM.md | 33 | `shared/coordinator/JobQueueManager.js` | `src/coordinator/JobQueueManager.js` |
| POW_SERVICE.md | 49 | `automation/http/fingerprinting/powServiceClient` | `src/shared/fingerprinting/powServiceClient` |
| POW_SERVICE.md | 74 | `pow-service.js` | `src/pow-service/index.js` |

### Remaining Docs-Only Historical References

Archive docs contain historical references to old paths. These are intentional and acceptable since they document the rewrite history.

---

## 12. Documentation Structure After Cleanup

```
Root (3 files):
  AGENTS.md                    — AI agent playbook
  AI_CONTEXT.md                — Architecture context
  README.md                    — Project documentation

docs/ (13 active files):
  README.md                    — Documentation index
  ARCHITECTURE.md              — System architecture
  SERVICES.md                  — Service responsibilities
  SHARED_MODULES.md            — Shared module reference
  ENVIRONMENT.md               — Environment variables
  DEPLOYMENT.md                — Deployment guide
  QUICKSTART.md                — Local dev setup
  POW_SERVICE_DEPLOYMENT.md    — POW deployment guide
  AWS_SETUP.md                 — AWS walkthrough
  CONFIG_SYSTEM.md             — Config feature docs
  POW_SERVICE.md               — POW integration
  OPERATIONS.md                — Quick update guide
  TESTING.md                   — Config testing

docs/archive/rewrite/ (7 files):
  phase-2-shared-migration.md
  phase-3-service-migration.md
  phase-4-deprecated-cleanup.md
  phase-5-root-deployment-plan.md
  phase-6-final-cleanup.md
  phase-7-deployment-env-cleanup.md
  phase-7-post-rewrite-verification.md

docs/archive/legacy/ (6 files):
  old-cleanup-report.md
  deprecated-audit.md
  deprecated-cleanup-plan.md
  deprecated-deprecation-map.md
  deprecated-folder-structure.md
  deprecated-rewrite-foundation.md

scripts/ (3 files):
  debug/README.md
  deploy/README.md
  maintenance/README.md

data/processed/ (2 files):
  PROXY_COOKIE_PROBLEM.md
  sample_order-history.md
```

**Total: 34 markdown files (16 active + 13 archive + 5 scripts/data)**

---

## 13. Validation Results

### Cross-Reference Validation
- ✓ All links in `docs/README.md` point to existing files
- ✓ All links in `AGENTS.md` point to existing files
- ✓ All links in `AI_CONTEXT.md` point to existing files
- ✓ All links in `README.md` point to existing files

### Stale Reference Validation
- ✓ No stale references to deleted files in current docs
- ✓ No references to old paths (main.js, worker.js, etc.) in current docs
- ✓ No references to single-node mode in current docs
- ✓ No references to JSONL fallback in current docs (except confirming it's removed)

### Structure Validation
- ✓ All archived docs are in `docs/archive/`
- ✓ All active docs are in `docs/`
- ✓ Root files (AGENTS.md, AI_CONTEXT.md, README.md) preserved
- ✓ Deployment artifacts remain in `deployment/`

---

## 14. Remaining Documentation Risks

### Low Risk
1. **Archive docs contain old paths** — Acceptable since they document rewrite history
2. **Scripts READMEs not updated** — They reference correct paths and don't need changes
3. **Data docs not updated** — They are data files, not documentation

### No Risk
1. **All cross-references validated** — No broken links
2. **All stale references fixed** — Current docs describe only final architecture
3. **Root files preserved** — AGENTS.md, AI_CONTEXT.md, README.md stay at root

---

## 15. Documentation Organization Status

**Status: COMPLETE**

All documentation has been organized into a clean, modular structure:
- 16 active docs in `docs/` and root
- 13 historical docs archived in `docs/archive/`
- 4 new consolidated docs created
- 10 stale references fixed
- All cross-references validated

---

## 16. Recommended Next Phase

The documentation organization is complete. Recommended next steps:

1. **Test migration** — Update test scripts to use new `src/` paths
2. **Integration testing** — Run `npm run test:integration` with Redis
3. **Docker build test** — Verify Docker builds with new structure
4. **Production deployment** — Deploy using new Docker/deployment configuration
