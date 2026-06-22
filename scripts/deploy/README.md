# Deployment Scripts

Scripts for updating and verifying the Rakuten distributed system on EC2 instances.

See [docs/OPERATIONS.md](../../docs/OPERATIONS.md) for the full update workflow and
[docs/AWS_SETUP.md](../../docs/AWS_SETUP.md) for first-time instance setup.

## Primary tools

- **`quick-update.sh`** — Recommended update script. Full rebuild (`git pull` → stop/rm → build → run)
  or `--fast` (cp → commit → recreate). Usage: `./scripts/deploy/quick-update.sh <coordinator|worker|pow-service|all> [--fast]`
- **`update-instance.js`** — Node.js update helper that backs `npm run update:*`. ⚠️ Not fully
  interchangeable with `quick-update.sh` for the POW service (different container name/ports); prefer
  `quick-update.sh`.

## Verification

- **`verify-pow-deployment.js`** — Verifies POW service deployment (backs `npm run verify:pow-deployment`)
- **`verify-deployment.sh`** — General deployment / health verification
- **`verify-redis-migration.js`** — Verifies a Redis data migration completed correctly
- **`test-redis-connectivity.js`** — Tests Redis connectivity and timeout configuration
- **`test-redis-timeouts.js`** — Exercises Redis command-timeout behavior

## Redis migration

- **`migrate-redis.sh`** — Redis migration helper (see also `scripts/migration/`)

## Legacy / situational

- **`deploy-worker-fix.sh`** — Historical one-off worker-timeout deployment fix. Superseded by
  `quick-update.sh`; kept for reference.
- **`rollback-worker.sh`** — Roll back to a previous worker container if an update regresses.

## Typical update

```bash
# On the EC2 instance
cd ~/rakuten
git pull
./scripts/deploy/quick-update.sh coordinator        # full rebuild
./scripts/deploy/quick-update.sh worker --fast       # JS-only fast update
```
