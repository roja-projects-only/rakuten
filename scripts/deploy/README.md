# Deployment Scripts

This directory contains the essential deployment scripts for the Rakuten distributed worker system.

## Quick Deployment

**For immediate worker timeout fix:**
```bash
./deploy-worker-fix.sh
```

## Scripts Overview

### Production Deployment
- `deploy-worker-fix.sh` - **Main deployment script** - fixes timeout issues and deploys workers
- `test-redis-connectivity.js` - Tests Redis connectivity and timeout configurations
- `verify-deployment.sh` - Verifies deployment success and system health

### Development/Testing
- `test-worker-locally.sh` - Test worker functionality locally before deployment
- `rollback-worker.sh` - Rollback to previous worker version if needed

## Usage

1. **SSH to your EC2 instance**
2. **Navigate to project directory**: `cd ~/rakuten`
3. **Pull latest changes**: `git pull`
4. **Run deployment**: `./scripts/deploy/deploy-worker-fix.sh`

The deployment script will handle everything automatically:
- Environment configuration
- Docker image rebuilding
- Container restart
- Health verification
- Logging setup