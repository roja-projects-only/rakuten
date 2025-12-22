#!/bin/bash

# Update .env.worker with timeout configurations
echo "📝 Updating .env.worker with timeout configurations..."

# Backup existing .env.worker
if [ -f .env.worker ]; then
    cp .env.worker .env.worker.backup.$(date +%Y%m%d_%H%M%S)
    echo "✅ Backed up existing .env.worker"
fi

# Add timeout configurations if they don't exist
echo ""
echo "Adding timeout configurations to .env.worker..."

# Check if timeout configs already exist
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
echo "📋 Current .env.worker timeout settings:"
grep -E "(REDIS_COMMAND_TIMEOUT|WORKER_QUEUE_TIMEOUT|WORKER_TASK_TIMEOUT|WORKER_HEARTBEAT_INTERVAL)" .env.worker 2>/dev/null || echo "No timeout settings found"

echo ""
echo "✅ Environment file updated. Now run: ./scripts/rebuild-worker.sh"