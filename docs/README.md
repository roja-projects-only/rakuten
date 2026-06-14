# Documentation Index

## For AI Agents

- [AGENTS.md](../AGENTS.md) — Playbook: commands, patterns, entry points
- [AI_CONTEXT.md](../AI_CONTEXT.md) — Deep architecture, data flows, storage

## For Developers

### Architecture & Services
- [ARCHITECTURE.md](ARCHITECTURE.md) — System architecture, data flow, service boundaries, Redis design
- [SERVICES.md](SERVICES.md) — Coordinator, worker, POW service, Telegram bot responsibilities
- [SHARED_MODULES.md](SHARED_MODULES.md) — Config, logger, Redis, HTTP, batch, fingerprinting, capture, payloads, errors, constants, utils

### Configuration & Environment
- [ENVIRONMENT.md](ENVIRONMENT.md) — Full environment variable reference
- [CONFIG_SYSTEM.md](CONFIG_SYSTEM.md) — Centralized /config command system

### Deployment
- [DEPLOYMENT.md](DEPLOYMENT.md) — Docker, Railway, AWS EC2, systemd, env files
- [QUICKSTART.md](QUICKSTART.md) — Local development setup
- [AWS_SETUP.md](AWS_SETUP.md) — AWS console walkthrough
- [POW_SERVICE_DEPLOYMENT.md](POW_SERVICE_DEPLOYMENT.md) — POW service deployment guide

### Operations
- [OPERATIONS.md](OPERATIONS.md) — Quick update guide, deployment scripts
- [POW_SERVICE.md](POW_SERVICE.md) — POW API reference and integration

### Testing
- [TESTING.md](TESTING.md) — Config system testing guide

## Archive

### Rewrite History
- [archive/rewrite/phase-2-shared-migration.md](archive/rewrite/phase-2-shared-migration.md) — Phase 2: Shared module migration
- [archive/rewrite/phase-3-service-migration.md](archive/rewrite/phase-3-service-migration.md) — Phase 3: Service module migration
- [archive/rewrite/phase-4-deprecated-cleanup.md](archive/rewrite/phase-4-deprecated-cleanup.md) — Phase 4: Deprecated code cleanup
- [archive/rewrite/phase-5-root-deployment-plan.md](archive/rewrite/phase-5-root-deployment-plan.md) — Phase 5: Root and deployment plan
- [archive/rewrite/phase-6-final-cleanup.md](archive/rewrite/phase-6-final-cleanup.md) — Phase 6: Final cleanup
- [archive/rewrite/phase-7-deployment-env-cleanup.md](archive/rewrite/phase-7-deployment-env-cleanup.md) — Phase 7: Deployment folder cleanup
- [archive/rewrite/phase-7-post-rewrite-verification.md](archive/rewrite/phase-7-post-rewrite-verification.md) — Phase 7: Post-rewrite verification

### Legacy Documentation
- [archive/legacy/old-cleanup-report.md](archive/legacy/old-cleanup-report.md) — Historical cleanup notes
- [archive/legacy/deprecated-audit.md](archive/legacy/deprecated-audit.md) — Workspace audit
- [archive/legacy/deprecated-cleanup-plan.md](archive/legacy/deprecated-cleanup-plan.md) — Cleanup and rewrite plan
- [archive/legacy/deprecated-deprecation-map.md](archive/legacy/deprecated-deprecation-map.md) — Deprecation catalog
- [archive/legacy/deprecated-folder-structure.md](archive/legacy/deprecated-folder-structure.md) — Folder structure design
- [archive/legacy/deprecated-rewrite-foundation.md](archive/legacy/deprecated-rewrite-foundation.md) — Rewrite foundation

## Quick Reference

### Entrypoints
- Coordinator: `src/coordinator/index.js`
- Worker: `src/worker/index.js`
- POW Service: `src/pow-service/index.js`

### Commands
```bash
npm run start:coordinator    # Start coordinator
npm run start:worker         # Start worker
npm run start:pow-service    # Start POW service
npm run test:integration     # Run integration tests
```

### Docker
```bash
docker compose -f deployment/docker/docker-compose.yml up -d
```
