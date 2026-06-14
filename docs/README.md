# Documentation Index

## For AI Agents

- [AGENTS.md](../AGENTS.md) — Entry point: rules, reading order, validation steps
- [AI_CONTEXT.md](../AI_CONTEXT.md) — Deep architecture, data flows, storage, how-tos

## Active Docs

### Architecture & Services
- [ARCHITECTURE.md](ARCHITECTURE.md) — System architecture, service boundaries, data flows, Redis design, module rules
- [SHARED_MODULES.md](SHARED_MODULES.md) — Config, logger, Redis, HTTP, batch, fingerprinting, capture, payloads, errors, constants, utils

### Configuration & Environment
- [ENVIRONMENT.md](ENVIRONMENT.md) — Full environment variable reference
- [CONFIG_SYSTEM.md](CONFIG_SYSTEM.md) — Centralized `/config` command system

### Deployment
- [AWS_SETUP.md](AWS_SETUP.md) — AWS EC2 console walkthrough (coordinator, worker, POW service)
- [OPERATIONS.md](OPERATIONS.md) — Docker-based update scripts and manual commands

### Services
- [POW_SERVICE.md](POW_SERVICE.md) — POW service API reference and integration

### Testing
- [TESTING.md](TESTING.md) — Local full-flow harness, integration tests, config system testing

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
npm run test:flow            # Local full-flow test (single process)
npm run test:integration     # Integration tests (requires Redis)
npm run test:config          # Config system tests
```
