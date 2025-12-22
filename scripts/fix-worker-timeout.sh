#!/bin/bash

# Fix Worker Redis Timeout Issues
# This script rebuilds the worker Docker image and restarts the container

echo "🔧 Fixing worker Redis timeout issues..."

# Stop the current worker
echo "Stopping current worker container..."
docker stop rakuten-worker 2>/dev/null || echo "Worker container not running"
docker rm rakuten-worker 2>/dev/null || echo "Worker container not found"

# Rebuild worker image
echo "Rebuilding worker Docker image..."
docker build -f Dockerfile.worker -t rakuten-worker .

if [ $? -ne 0 ]; then
    echo "❌ Failed to build worker image"
    exit 1
fi

# Start worker with updated configuration
echo "Starting worker with fixed configuration..."
docker run -d \
  --name rakuten-worker \
  --restart unless-stopped \
  --env-file .env.worker \
  rakuten-worker

if [ $? -eq 0 ]; then
    echo "✅ Worker started successfully"
    echo "📋 Checking worker logs..."
    sleep 3
    docker logs --tail 20 rakuten-worker
else
    echo "❌ Failed to start worker"
    exit 1
fi

echo ""
echo "🔍 Monitor worker logs with: docker logs -f rakuten-worker"
echo "📊 Check worker status with: docker ps | grep rakuten-worker"