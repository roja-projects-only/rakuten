#!/bin/bash

# Worker Rollback Script
# Rolls back to a previous worker configuration if deployment fails

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

success() { echo -e "${GREEN}✅ $1${NC}"; }
error() { echo -e "${RED}❌ $1${NC}"; }
warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
info() { echo -e "${BLUE}ℹ️  $1${NC}"; }

echo -e "${BLUE}🔄 Worker Rollback Utility${NC}"
echo "=========================="

# Find backup files
BACKUP_FILES=($(ls -t .env.worker.backup.* 2>/dev/null || echo ""))

if [[ ${#BACKUP_FILES[@]} -eq 0 ]]; then
    error "No backup files found"
    exit 1
fi

echo "Available backups:"
for i in "${!BACKUP_FILES[@]}"; do
    echo "  $((i+1)). ${BACKUP_FILES[$i]}"
done

# Select backup
read -p "Select backup to restore (1-${#BACKUP_FILES[@]}): " -n 1 -r
echo

if [[ ! $REPLY =~ ^[1-${#BACKUP_FILES[@]}]$ ]]; then
    error "Invalid selection"
    exit 1
fi

SELECTED_BACKUP="${BACKUP_FILES[$((REPLY-1))]}"
info "Selected backup: $SELECTED_BACKUP"

# Confirm rollback
read -p "Are you sure you want to rollback? This will stop the current worker. (y/N): " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    info "Rollback cancelled"
    exit 0
fi

# Perform rollback
info "Starting rollback process..."

# Stop current worker
info "Stopping current worker..."
docker stop rakuten-worker 2>/dev/null || warning "Worker was not running"
docker rm rakuten-worker 2>/dev/null || warning "Worker container not found"

# Restore backup configuration
info "Restoring configuration from backup..."
cp "$SELECTED_BACKUP" .env.worker
success "Configuration restored from $SELECTED_BACKUP"

# Rebuild and start worker
info "Rebuilding worker with restored configuration..."
docker build -f Dockerfile.worker -t rakuten-worker .

if [[ $? -eq 0 ]]; then
    success "Worker image rebuilt"
else
    error "Failed to rebuild worker image"
    exit 1
fi

info "Starting worker with restored configuration..."
docker run -d \
    --name rakuten-worker \
    --restart unless-stopped \
    --env-file .env.worker \
    rakuten-worker

if [[ $? -eq 0 ]]; then
    success "Worker started with restored configuration"
else
    error "Failed to start worker"
    exit 1
fi

# Wait and verify
sleep 5
if docker ps | grep -q rakuten-worker; then
    success "Rollback completed successfully"
    info "Worker is running with restored configuration"
    
    echo ""
    info "Recent logs:"
    docker logs --tail 10 rakuten-worker
else
    error "Rollback failed - worker is not running"
    exit 1
fi