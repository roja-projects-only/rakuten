# Quick Update Guide

## Prerequisites

Create environment files from examples:

```bash
cp deployment/.env.coordinator.example .env.coordinator
cp deployment/.env.worker.example .env.worker
cp deployment/.env.pow-service.example .env.pow-service

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

# Update coordinator
cd rakuten && ./scripts/deploy/quick-update.sh coordinator

# Update worker
cd rakuten && ./scripts/deploy/quick-update.sh worker

# Update pow-service
cd rakuten && ./scripts/deploy/quick-update.sh pow

# Update all services
./scripts/deploy/quick-update.sh all
```

### Node.js Script (Alternative)

```bash
node scripts/deploy/update-instance.js coordinator
node scripts/deploy/update-instance.js worker
node scripts/deploy/update-instance.js pow
node scripts/deploy/update-instance.js all
```

---

## What It Does

1. ✅ `git pull` - Gets latest code
2. ✋ `docker stop` - Stops running container
3. 🗑️ `docker rm` - Removes old container
4. 🔨 `docker build` - Builds new image
5. ▶️ `docker run` - Starts container with `--env-file`
6. 📋 `docker logs -f` - Shows logs (Ctrl+C to exit)

---

## Manual Commands (Reference)

### POW Service

```bash
docker stop rakuten-pow
docker rm rakuten-pow
docker build -f Dockerfile.pow-service -t rakuten-pow .
docker run -d \
  --name rakuten-pow \
  --restart unless-stopped \
  -p 8080:8080 \
  -p 9090:9090 \
  --env-file .env.pow-service \
  rakuten-pow
docker logs -f rakuten-pow
```

### Coordinator

```bash
docker stop rakuten-coordinator
docker rm rakuten-coordinator
docker build -f Dockerfile.coordinator -t rakuten-coordinator .
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
docker build -f Dockerfile.worker -t rakuten-worker .
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
docker logs -f rakuten-pow

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
docker stop rakuten-coordinator rakuten-worker rakuten-pow

# Remove all
docker rm -f rakuten-coordinator rakuten-worker rakuten-pow

# Rebuild and start
./scripts/deploy/quick-update.sh all
```
