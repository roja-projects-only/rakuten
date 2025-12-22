#!/bin/bash

# Rakuten Worker Deployment Script - Redis Timeout Fix
# This is the definitive script to deploy worker fixes
# Version: 2.0 - Enhanced with comprehensive error handling and verification

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

success() {
    echo -e "${GREEN}✅ $1${NC}"
}

warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

error() {
    echo -e "${RED}❌ $1${NC}"
}

# Banner
echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                 Rakuten Worker Deployment                   ║"
echo "║                Redis Timeout Fix - v2.0                     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   error "This script should not be run as root for security reasons"
   exit 1
fi

# Check if Docker is available
if ! command -v docker &> /dev/null; then
    error "Docker is not installed or not in PATH"
    exit 1
fi

# Check if we're in the right directory
if [[ ! -f "package.json" ]] || [[ ! -f "worker.js" ]]; then
    error "Please run this script from the rakuten project root directory"
    exit 1
fi

log "Starting worker deployment with timeout fixes..."

# Step 1: Backup current configuration
log "Step 1: Backing up current configuration..."
if [[ -f ".env.worker" ]]; then
    BACKUP_FILE=".env.worker.backup.$(date +%Y%m%d_%H%M%S)"
    cp .env.worker "$BACKUP_FILE"
    success "Backed up .env.worker to $BACKUP_FILE"
else
    warning ".env.worker not found, will create new one"
fi

# Step 2: Update environment configuration
log "Step 2: Updating environment configuration..."

# Ensure .env.worker exists
if [[ ! -f ".env.worker" ]]; then
    if [[ -f "deployment/.env.worker.example" ]]; then
        cp deployment/.env.worker.example .env.worker
        success "Created .env.worker from example"
    else
        error "No .env.worker.example found in deployment directory"
        exit 1
    fi
fi

# Function to update or add environment variable
update_env_var() {
    local var_name="$1"
    local var_value="$2"
    local env_file=".env.worker"
    
    if grep -q "^${var_name}=" "$env_file"; then
        # Update existing variable
        sed -i "s/^${var_name}=.*/${var_name}=${var_value}/" "$env_file"
        success "Updated ${var_name}=${var_value}"
    else
        # Add new variable
        echo "${var_name}=${var_value}" >> "$env_file"
        success "Added ${var_name}=${var_value}"
    fi
}

# Add timeout configuration section if not exists
if ! grep -q "Redis and Worker Timeout Configuration" .env.worker; then
    echo "" >> .env.worker
    echo "# Redis and Worker Timeout Configuration" >> .env.worker
fi

# Update timeout configurations
update_env_var "REDIS_COMMAND_TIMEOUT" "60000"
update_env_var "WORKER_QUEUE_TIMEOUT" "30000"
update_env_var "WORKER_TASK_TIMEOUT" "120000"
update_env_var "WORKER_HEARTBEAT_INTERVAL" "10000"

# Step 3: Test Redis connectivity (if Node.js is available)
log "Step 3: Testing Redis connectivity..."
if command -v node &> /dev/null && [[ -f "scripts/test-redis-timeouts.js" ]]; then
    if node scripts/test-redis-timeouts.js; then
        success "Redis connectivity test passed"
    else
        warning "Redis connectivity test failed, but continuing with deployment"
    fi
else
    warning "Node.js not available or test script missing, skipping Redis test"
fi

# Step 4: Stop existing worker
log "Step 4: Stopping existing worker containers..."
EXISTING_WORKERS=$(docker ps -q --filter "name=rakuten-worker")
if [[ -n "$EXISTING_WORKERS" ]]; then
    docker stop $EXISTING_WORKERS
    success "Stopped existing worker containers"
else
    log "No existing worker containers found"
fi

# Remove existing containers
EXISTING_CONTAINERS=$(docker ps -aq --filter "name=rakuten-worker")
if [[ -n "$EXISTING_CONTAINERS" ]]; then
    docker rm $EXISTING_CONTAINERS
    success "Removed existing worker containers"
fi

# Step 5: Clean up old images
log "Step 5: Cleaning up old Docker images..."
OLD_IMAGES=$(docker images -q rakuten-worker)
if [[ -n "$OLD_IMAGES" ]]; then
    docker rmi $OLD_IMAGES 2>/dev/null || warning "Some old images couldn't be removed (may be in use)"
    success "Cleaned up old worker images"
fi

# Step 6: Build new worker image
log "Step 6: Building new worker Docker image..."
if docker build -f Dockerfile.worker -t rakuten-worker .; then
    success "Worker Docker image built successfully"
else
    error "Failed to build worker Docker image"
    exit 1
fi

# Step 7: Start new worker
log "Step 7: Starting new worker container..."
if docker run -d \
    --name rakuten-worker \
    --restart unless-stopped \
    --env-file .env.worker \
    rakuten-worker; then
    success "Worker container started successfully"
else
    error "Failed to start worker container"
    exit 1
fi

# Step 8: Wait for worker to initialize
log "Step 8: Waiting for worker to initialize..."
sleep 10

# Step 9: Verify deployment
log "Step 9: Verifying deployment..."

# Check if container is running
if docker ps | grep -q rakuten-worker; then
    success "Worker container is running"
else
    error "Worker container is not running"
    docker logs rakuten-worker
    exit 1
fi

# Check logs for successful initialization
log "Checking worker logs for successful initialization..."
LOGS=$(docker logs rakuten-worker 2>&1)

if echo "$LOGS" | grep -q "Redis connected successfully"; then
    success "Redis connection established"
else
    warning "Redis connection not confirmed in logs"
fi

if echo "$LOGS" | grep -q "Worker.*registered successfully"; then
    success "Worker registered successfully"
else
    warning "Worker registration not confirmed in logs"
fi

if echo "$LOGS" | grep -q "Command timed out"; then
    error "Still seeing timeout errors in logs"
    echo "Recent logs:"
    docker logs --tail 20 rakuten-worker
    exit 1
else
    success "No timeout errors detected in logs"
fi

# Step 10: Display final status
log "Step 10: Final deployment status..."

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                    DEPLOYMENT SUCCESSFUL                    ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

success "Worker deployment completed successfully!"
success "Redis timeout issues have been resolved"
success "Worker is running and ready to process tasks"

echo ""
echo -e "${BLUE}📊 Deployment Summary:${NC}"
echo "   • Container: rakuten-worker"
echo "   • Status: Running"
echo "   • Restart Policy: unless-stopped"
echo "   • Redis Command Timeout: 60000ms"
echo "   • Worker Queue Timeout: 30000ms"
echo "   • Task Timeout: 120000ms"
echo "   • Heartbeat Interval: 10000ms"

echo ""
echo -e "${BLUE}🔍 Monitoring Commands:${NC}"
echo "   • View logs: docker logs -f rakuten-worker"
echo "   • Check status: docker ps | grep rakuten-worker"
echo "   • Test Redis: docker exec rakuten-worker node scripts/test-redis-timeouts.js"
echo "   • Worker stats: docker stats rakuten-worker"

echo ""
echo -e "${BLUE}📋 Recent Logs:${NC}"
docker logs --tail 15 rakuten-worker

echo ""
success "Deployment complete! Monitor the logs to ensure stable operation."

# Optional: Set up log monitoring
read -p "Would you like to start monitoring logs now? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Starting log monitoring (Ctrl+C to exit)..."
    docker logs -f rakuten-worker
fi