# Quick Update Guide

## After `git pull` - Update Running Instances

### Option 1: Node.js Script (Cross-platform)

```bash
# Update all services
node scripts/deploy/update-instance.js

# Update specific service
node scripts/deploy/update-instance.js coordinator
node scripts/deploy/update-instance.js worker
node scripts/deploy/update-instance.js pow-service
```

**What it does:**
1. ✋ Stops running container
2. 🗑️ Removes old container
3. 🔨 Builds new image
4. ▶️ Starts new container
5. 📋 Shows recent logs

### Option 2: Bash Script (Linux/Mac)

```bash
# Make executable (first time only)
chmod +x scripts/deploy/quick-update.sh

# Update all services (includes git pull)
./scripts/deploy/quick-update.sh

# Update specific service
./scripts/deploy/quick-update.sh coordinator
./scripts/deploy/quick-update.sh worker
```

**Bonus:** Includes git pull in the workflow

---

## On AWS EC2 Instances

### SSH and Update

```bash
# SSH into instance
ssh user@instance-ip

# Navigate to app directory
cd /app  # or wherever your app is

# Pull latest code
git pull

# Run update script
./scripts/deploy/quick-update.sh

# Or update specific service
./scripts/deploy/quick-update.sh coordinator
```

### One-liner for Multiple Instances

```bash
# Update coordinator
ssh user@coordinator-ip "cd /app && git pull && ./scripts/deploy/quick-update.sh coordinator"

# Update worker 1
ssh user@worker1-ip "cd /app && git pull && ./scripts/deploy/quick-update.sh worker"

# Update worker 2
ssh user@worker2-ip "cd /app && git pull && ./scripts/deploy/quick-update.sh worker"
```

---

## On Railway

### Using Railway CLI

Railway handles deployments differently - pushes trigger automatic rebuilds.

**Option A: Push to trigger deploy**
```bash
git push
railway up  # Rebuilds and redeploys
```

**Option B: Manual redeploy**
```bash
railway redeploy --service coordinator
railway redeploy --service worker
railway redeploy --service pow-service
```

**Option C: Run update script remotely**
```bash
# If using Docker on Railway
railway run --service coordinator node scripts/deploy/update-instance.js coordinator
```

---

## Manual Docker Commands

If scripts fail, use manual commands:

### Stop and Remove
```bash
docker-compose stop coordinator
docker-compose rm -f coordinator
```

### Build and Start
```bash
docker-compose build coordinator
docker-compose up -d coordinator
```

### Check Status
```bash
docker-compose ps
docker-compose logs -f coordinator
```

### Full Reset (All Services)
```bash
docker-compose down
docker-compose build
docker-compose up -d
docker-compose logs -f
```

---

## Deployment Checklist

### Before Deployment

- [ ] Code tested locally
- [ ] Tests passing (`npm run test:config`)
- [ ] `.env` variables updated if needed
- [ ] `docker-compose.yml` changes reviewed
- [ ] Database migrations ready (if any)

### During Deployment

- [ ] Git pull successful
- [ ] Docker build successful
- [ ] Containers started successfully
- [ ] No errors in logs
- [ ] Services responding to health checks

### After Deployment

- [ ] Test `/config` command in Telegram
- [ ] Verify batch processing works
- [ ] Check worker task processing
- [ ] Monitor logs for 5-10 minutes
- [ ] Verify Redis connectivity

---

## Rollback Procedure

If deployment fails:

### Quick Rollback (Git)
```bash
# Revert to previous commit
git log --oneline -n 5  # Find previous commit
git reset --hard <commit-hash>

# Update containers
./scripts/deploy/quick-update.sh
```

### Docker Rollback (Previous Image)
```bash
# List images
docker images | grep rakuten

# Tag previous image
docker tag rakuten-coordinator:previous rakuten-coordinator:latest

# Restart with previous image
docker-compose up -d coordinator
```

### Emergency Stop
```bash
# Stop everything
docker-compose down

# Check what's running
docker ps

# Force remove if needed
docker rm -f $(docker ps -aq --filter "name=rakuten")
```

---

## Monitoring After Update

### Real-time Logs
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f coordinator

# Follow with grep
docker-compose logs -f | grep -i error
docker-compose logs -f coordinator | grep "Config"
```

### Health Checks
```bash
# Check if containers are running
docker-compose ps

# Check resource usage
docker stats

# Check network connectivity
docker-compose exec coordinator ping -c 3 worker
```

### Verify Config Service
```bash
# On coordinator
docker-compose exec coordinator node scripts/tests/verify-config-deployment.js

# On worker
docker-compose exec worker node scripts/tests/verify-config-deployment.js
```

---

## Common Issues

### Issue: "docker-compose not found"
**Fix:**
```bash
# Install docker-compose
curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose
```

### Issue: "Port already in use"
**Fix:**
```bash
# Find process using port
lsof -i :9090  # or your port
# or
netstat -tulpn | grep 9090

# Kill process
kill -9 <pid>

# Or use different port in .env
```

### Issue: "Build failed - out of space"
**Fix:**
```bash
# Clean up Docker
docker system prune -a
docker volume prune

# Check space
df -h
```

### Issue: "Container keeps restarting"
**Fix:**
```bash
# Check logs
docker-compose logs coordinator

# Check config
docker-compose config

# Verify environment
docker-compose exec coordinator env | grep REDIS
```

---

## Advanced: Multi-Instance Update

Update multiple AWS instances at once:

```bash
#!/bin/bash
# update-all-instances.sh

COORDINATOR="user@coordinator-ip"
WORKERS=("user@worker1-ip" "user@worker2-ip" "user@worker3-ip")

echo "Updating coordinator..."
ssh $COORDINATOR "cd /app && git pull && ./scripts/deploy/quick-update.sh coordinator"

for worker in "${WORKERS[@]}"; do
  echo "Updating $worker..."
  ssh $worker "cd /app && git pull && ./scripts/deploy/quick-update.sh worker" &
done

wait
echo "All instances updated!"
```

Make it executable:
```bash
chmod +x scripts/deploy/update-all-instances.sh
./scripts/deploy/update-all-instances.sh
```

---

## Best Practices

1. **Always pull first:**
   ```bash
   git pull && ./scripts/deploy/quick-update.sh
   ```

2. **Update one service at a time in production:**
   ```bash
   ./scripts/deploy/quick-update.sh coordinator
   # Wait and verify
   ./scripts/deploy/quick-update.sh worker
   ```

3. **Keep logs of deployments:**
   ```bash
   ./scripts/deploy/quick-update.sh 2>&1 | tee deploy-$(date +%Y%m%d-%H%M%S).log
   ```

4. **Monitor for 5 minutes after update:**
   ```bash
   docker-compose logs -f --tail=100
   ```

5. **Test config changes:**
   ```bash
   # After update
   /config list  # in Telegram
   ```

---

## Automation (CI/CD)

For future: GitHub Actions workflow

```yaml
# .github/workflows/deploy.yml
name: Deploy to AWS
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Deploy to Coordinator
        run: |
          ssh ${{ secrets.COORDINATOR_HOST }} "cd /app && git pull && ./scripts/deploy/quick-update.sh coordinator"
```
