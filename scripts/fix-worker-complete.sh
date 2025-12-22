#!/bin/bash

# Complete worker timeout fix - updates env and rebuilds
echo "🚀 Complete worker timeout fix starting..."
echo ""

# Step 1: Update environment file
echo "📝 Step 1: Updating .env.worker with timeout configurations..."

# Backup existing .env.worker
if [ -f .env.worker ]; then
    cp .env.worker .env.worker.backup.$(date +%Y%m%d_%H%M%S)
    echo "✅ Backed up existing .env.worker"
fi

# Add timeout configurations if they don't exist
if ! grep -q "REDIS_COMMAND_TIMEOUT" .env.worker 2>/dev/null; then
    echo "" >> .env.worker
    echo "# Redis and Worker Timeout Configuration" >> .env.worker
    echo "REDIS_COMMAND_TIMEOUT=60000" >> .env.worker
    echo "✅ Added REDIS_COMMAND_TIMEOUT=60000"
fi

if ! grep -q "WORKER_QUEUE_TIMEOUT" .env.worker 2>/dev/null; then
    echo "WORKER_QUEUE_TIMEOUT=30000" >> .env.worker
    echo "✅ Added WORKER_QUEUE_TIMEOUT=30000"
fi

if ! grep -q "WORKER_TASK_TIMEOUT" .env.worker 2>/dev/null; then
    echo "WORKER_TASK_TIMEOUT=120000" >> .env.worker
    echo "✅ Added WORKER_TASK_TIMEOUT=120000"
fi

if ! grep -q "WORKER_HEARTBEAT_INTERVAL" .env.worker 2>/dev/null; then
    echo "WORKER_HEARTBEAT_INTERVAL=10000" >> .env.worker
    echo "✅ Added WORKER_HEARTBEAT_INTERVAL=10000"
fi

echo ""
echo "📋 Current timeout settings:"
grep -E "(REDIS_COMMAND_TIMEOUT|WORKER_QUEUE_TIMEOUT|WORKER_TASK_TIMEOUT|WORKER_HEARTBEAT_INTERVAL)" .env.worker

echo ""
echo "🔧 Step 2: Rebuilding worker with timeout fixes..."

# Stop and remove existing container
echo "Stopping existing worker..."
docker stop rakuten-worker 2>/dev/null
docker rm rakuten-worker 2>/dev/null

# Remove old image to force rebuild
echo "Removing old worker image..."
docker rmi rakuten-worker 2>/dev/null

# Rebuild worker image with latest code
echo "Building new worker image..."
docker build -f Dockerfile.worker -t rakuten-worker .

if [ $? -ne 0 ]; then
    echo "❌ Failed to build worker image"
    exit 1
fi

echo "✅ Worker image built successfully"

# Start worker with updated configuration
echo ""
echo "🚀 Step 3: Starting worker with fixed configuration..."
docker run -d \
  --name rakuten-worker \
  --restart unless-stopped \
  --env-file .env.worker \
  rakuten-worker

if [ $? -eq 0 ]; then
    echo "✅ Worker started successfully"
    echo ""
    echo "📋 Checking worker logs (waiting 5 seconds)..."
    sleep 5
    docker logs --tail 30 rakuten-worker
    echo ""
    echo "🎉 Fix complete! Worker should no longer have timeout errors."
    echo ""
    echo "🔍 Monitor logs with: docker logs -f rakuten-worker"
    echo "📊 Check status with: docker ps | grep rakuten-worker"
else
    echo "❌ Failed to start worker"
    exit 1
fi