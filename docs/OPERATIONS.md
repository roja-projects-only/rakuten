# Quick Update Guide

## Prerequisites

Create environment files from examples:

```bash
cp deployment/env/coordinator.env.example .env.coordinator
cp deployment/env/worker.env.example .env.worker
cp deployment/env/pow-service.env.example .env.pow-service

# Edit each file with your settings
nano .env.coordinator
nano .env.worker
nano .env.pow-service
```

---

## Update Commands

### Bash Script (Recommended)

```bash
# Make executable (first time only)
chmod +x scripts/deploy/quick-update.sh

# Full rebuild (needed when package.json changes)
cd rakuten && ./scripts/deploy/quick-update.sh coordinator
cd rakuten && ./scripts/deploy/quick-update.sh worker
cd rakuten && ./scripts/deploy/quick-update.sh pow
cd rakuten && ./scripts/deploy/quick-update.sh all

# Fast update — JS-only changes (~5 seconds, skips docker build)
cd rakuten && ./scripts/deploy/quick-update.sh coordinator --fast
cd rakuten && ./scripts/deploy/quick-update.sh worker --fast
cd rakuten && ./scripts/deploy/quick-update.sh pow --fast
cd rakuten && ./scripts/deploy/quick-update.sh all --fast
```

### Node.js Script (Alternative)

```bash
node scripts/deploy/update-instance.js coordinator
node scripts/deploy/update-instance.js worker
node scripts/deploy/update-instance.js pow
node scripts/deploy/update-instance.js all
```

> ⚠️ `quick-update.sh` is the recommended tool. `update-instance.js` currently names the POW
> container `rakuten-pow` (not `rakuten-pow-service`) and maps ports `8080:8080` (not `8080:3001`),
> so the two tools are **not** interchangeable for the POW service — mixing them can leave two
> POW containers contending for port 8080. Prefer `quick-update.sh` until this is reconciled.

---

## What It Does

**Full rebuild (default):**
1. `git pull` — gets latest code
2. `docker stop` — stops running container
3. `docker rm` — removes old container
4. `docker build` — builds new image
5. `docker run` — starts container with `--env-file`
6. `docker logs -f` — shows logs (Ctrl+C to exit)

**Fast mode (`--fast`):**
1. `git pull` — gets latest code
2. `docker cp` — copies changed `src/` + `package.json` into the running container
3. `docker commit` — commits the container to its image so the copied files survive recreation
4. `docker stop` + `docker rm -f` + `docker run` — recreates the container from the committed image (~5 seconds total)

> `--fast` does **not** run `npm install`. Use a full rebuild for any dependency change. Note that fast
> updates leave the image tag pointing at a committed (non-pristine) layer until the next full rebuild.

---

## Manual Commands (Reference)

### POW Service

```bash
docker stop rakuten-pow-service
docker rm rakuten-pow-service
DOCKER_BUILDKIT=1 docker build -f deployment/docker/Dockerfile.pow-service -t rakuten-pow-service .
docker run -d \
  --name rakuten-pow-service \
  --restart unless-stopped \
  -p 8080:3001 \
  --env-file .env.pow-service \
  rakuten-pow-service
docker logs -f rakuten-pow-service
```

### Coordinator

```bash
docker stop rakuten-coordinator
docker rm rakuten-coordinator
DOCKER_BUILDKIT=1 docker build -f deployment/docker/Dockerfile.coordinator -t rakuten-coordinator .
docker run -d \
  --name rakuten-coordinator \
  --restart unless-stopped \
  -p 9090:9090 \
  --env-file .env.coordinator \
  rakuten-coordinator
docker logs -f rakuten-coordinator
```

### Worker

```bash
docker stop rakuten-worker
docker rm rakuten-worker
DOCKER_BUILDKIT=1 docker build -f deployment/docker/Dockerfile.worker -t rakuten-worker .
docker run -d \
  --name rakuten-worker \
  --restart unless-stopped \
  --env-file .env.worker \
  rakuten-worker
docker logs -f rakuten-worker
```

---

## SSH Quick Update

```bash
# Single command to update coordinator
ssh ubuntu@your-ip "cd ~/rakuten && ./scripts/deploy/quick-update.sh coordinator"
```

---

## Check Status

```bash
# List all rakuten containers
docker ps --filter "name=rakuten"

# View logs
docker logs -f rakuten-coordinator
docker logs -f rakuten-worker
docker logs -f rakuten-pow-service

# Check container stats
docker stats --filter "name=rakuten"
```

---

## Troubleshooting

### Container name in use

```bash
# Force remove the stuck container
docker rm -f rakuten-coordinator
```

### View all containers (including stopped)

```bash
docker ps -a --filter "name=rakuten"
```

### Clean up old images

```bash
docker image prune -f
```

### Full reset

```bash
# Stop all
docker stop rakuten-coordinator rakuten-worker rakuten-pow-service

# Remove all
docker rm -f rakuten-coordinator rakuten-worker rakuten-pow-service

# Rebuild and start
./scripts/deploy/quick-update.sh all
```
