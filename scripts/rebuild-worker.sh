#!/bin/bash

# Rebuild and restart worker with timeout fixes
# Run this on your EC2 instance

echo "🔧 Rebuilding worker with timeout fixes..."

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
echo "Starting worker..."
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
    echo "🔍 Monitor logs with: docker logs -f rakuten-worker"
else
    echo "❌ Failed to start worker"
    exit 1
fi
