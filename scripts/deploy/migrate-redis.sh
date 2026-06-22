#!/bin/bash

# Redis Migration Script for Railway Redis Instances
# Migrates data from old single-node Redis to new Redis

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

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                    Redis Data Migration                     ║"
echo "║              From Old Railway to New Railway                ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    error "Node.js is required for migration"
    exit 1
fi

# Check if we're in the right directory
if [[ ! -f "package.json" ]]; then
    error "Please run this script from the rakuten project root directory"
    exit 1
fi

# Check for migration script
if [[ ! -f "scripts/migrate-redis-data.js" ]]; then
    error "Migration script not found: scripts/migrate-redis-data.js"
    exit 1
fi

info "Redis Migration Setup"
echo "====================="

# Get Redis URLs
echo ""
info "Please provide your Redis connection URLs:"
echo ""

# Get old Redis URL
read -p "🔗 Old Railway Redis URL (the one you want to migrate FROM): " OLD_REDIS_URL
if [[ -z "$OLD_REDIS_URL" ]]; then
    error "Old Redis URL is required"
    exit 1
fi

# Get new Redis URL
read -p "🔗 New Railway Redis URL (the one you want to migrate TO): " NEW_REDIS_URL
if [[ -z "$NEW_REDIS_URL" ]]; then
    error "New Redis URL is required"
    exit 1
fi

# Validate URLs
if [[ ! "$OLD_REDIS_URL" =~ ^redis:// ]]; then
    error "Old Redis URL must start with redis://"
    exit 1
fi

if [[ ! "$NEW_REDIS_URL" =~ ^redis:// ]]; then
    error "New Redis URL must start with redis://"
    exit 1
fi

echo ""
info "Migration Configuration:"
echo "   From: ${OLD_REDIS_URL:0:20}...***"
echo "   To:   ${NEW_REDIS_URL:0:20}...***"

# Test connections first
echo ""
info "Testing Redis connections..."

# Test old Redis
if timeout 10 redis-cli -u "$OLD_REDIS_URL" ping > /dev/null 2>&1; then
    success "Old Redis connection successful"
else
    error "Cannot connect to old Redis. Please check the URL."
    exit 1
fi

# Test new Redis
if timeout 10 redis-cli -u "$NEW_REDIS_URL" ping > /dev/null 2>&1; then
    success "New Redis connection successful"
else
    error "Cannot connect to new Redis. Please check the URL."
    exit 1
fi

# Get key count from old Redis
OLD_KEY_COUNT=$(redis-cli -u "$OLD_REDIS_URL" dbsize 2>/dev/null || echo "unknown")
NEW_KEY_COUNT=$(redis-cli -u "$NEW_REDIS_URL" dbsize 2>/dev/null || echo "unknown")

echo ""
info "Current key counts:"
echo "   Old Redis: $OLD_KEY_COUNT keys"
echo "   New Redis: $NEW_KEY_COUNT keys"

if [[ "$NEW_KEY_COUNT" != "0" ]] && [[ "$NEW_KEY_COUNT" != "unknown" ]]; then
    warning "New Redis already contains $NEW_KEY_COUNT keys"
    echo "   Migration will skip existing keys to avoid overwriting"
fi

# Final confirmation
echo ""
warning "This will migrate ALL data from old Redis to new Redis"
warning "Existing keys in new Redis will be preserved (not overwritten)"
echo ""
read -p "Are you sure you want to proceed? (y/N): " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    info "Migration cancelled"
    exit 0
fi

# Run migration
echo ""
info "Starting Redis migration..."
echo "This may take several minutes depending on data size..."
echo ""

# Export environment variables and run migration
export OLD_REDIS_URL="$OLD_REDIS_URL"
export NEW_REDIS_URL="$NEW_REDIS_URL"

if node scripts/migrate-redis-data.js; then
    echo ""
    success "Migration completed successfully!"
    
    # Get final key counts
    FINAL_OLD_COUNT=$(redis-cli -u "$OLD_REDIS_URL" dbsize 2>/dev/null || echo "unknown")
    FINAL_NEW_COUNT=$(redis-cli -u "$NEW_REDIS_URL" dbsize 2>/dev/null || echo "unknown")
    
    echo ""
    info "Final key counts:"
    echo "   Old Redis: $FINAL_OLD_COUNT keys"
    echo "   New Redis: $FINAL_NEW_COUNT keys"
    
    echo ""
    success "Next steps:"
    echo "1. Update your .env files to use the new Redis URL"
    echo "2. Test your application with the new Redis"
    echo "3. Once verified, you can delete the old Redis instance"
    
    echo ""
    info "To update worker configuration:"
    echo "   1. Update REDIS_URL in .env.worker"
    echo "   2. Run: ./scripts/deploy/deploy-worker-fix.sh"
    
else
    error "Migration failed!"
    echo ""
    warning "Your data is safe - no changes were made to the old Redis"
    warning "Check the error messages above and try again"
    exit 1
fi