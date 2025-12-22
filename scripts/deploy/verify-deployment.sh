#!/bin/bash

# Deployment Verification Script
# Verifies that the worker deployment was successful and is operating correctly

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

echo -e "${BLUE}🔍 Verifying Worker Deployment${NC}"
echo "=================================="

# Check if container exists and is running
if docker ps | grep -q rakuten-worker; then
    success "Worker container is running"
    
    # Get container info
    CONTAINER_ID=$(docker ps -q --filter "name=rakuten-worker")
    UPTIME=$(docker ps --filter "name=rakuten-worker" --format "table {{.Status}}" | tail -n +2)
    success "Container uptime: $UPTIME"
else
    error "Worker container is not running"
    
    # Check if container exists but stopped
    if docker ps -a | grep -q rakuten-worker; then
        warning "Worker container exists but is stopped"
        echo "Container logs:"
        docker logs --tail 20 rakuten-worker
    else
        error "Worker container does not exist"
    fi
    exit 1
fi

# Check logs for successful initialization
echo ""
info "Checking worker logs..."

LOGS=$(docker logs rakuten-worker 2>&1)

# Check for Redis connection
if echo "$LOGS" | grep -q "Redis connected successfully"; then
    success "Redis connection established"
else
    error "Redis connection not found in logs"
fi

# Check for worker registration
if echo "$LOGS" | grep -q "Worker.*registered successfully"; then
    success "Worker registered with coordinator"
else
    warning "Worker registration not confirmed"
fi

# Check for timeout errors
if echo "$LOGS" | grep -q "Command timed out"; then
    error "Timeout errors still present in logs"
    echo "Recent timeout errors:"
    echo "$LOGS" | grep "Command timed out" | tail -5
    exit 1
else
    success "No timeout errors detected"
fi

# Check for heartbeat activity
if echo "$LOGS" | grep -q "Heartbeat sent"; then
    success "Heartbeat mechanism working"
else
    warning "No heartbeat activity detected yet (may be too early)"
fi

# Test Redis connectivity from within container
echo ""
info "Testing Redis connectivity from worker container..."

if docker exec rakuten-worker node scripts/deploy/test-redis-connectivity.js > /dev/null 2>&1; then
    success "Redis connectivity test passed"
else
    warning "Redis connectivity test failed or script not found"
fi

# Check environment variables
echo ""
info "Verifying timeout configuration..."

ENV_CHECK=$(docker exec rakuten-worker env | grep -E "(REDIS_COMMAND_TIMEOUT|WORKER_QUEUE_TIMEOUT)" || echo "")
if [[ -n "$ENV_CHECK" ]]; then
    success "Timeout environment variables configured:"
    echo "$ENV_CHECK" | sed 's/^/   /'
else
    warning "Timeout environment variables not found"
fi

# Check container resource usage
echo ""
info "Container resource usage:"
docker stats rakuten-worker --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}"

# Final status
echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║        VERIFICATION COMPLETE        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"

success "Worker deployment verification completed"
info "Monitor with: docker logs -f rakuten-worker"
info "Check status: docker ps | grep rakuten-worker"

echo ""
echo "Recent logs (last 10 lines):"
echo "----------------------------"
docker logs --tail 10 rakuten-worker