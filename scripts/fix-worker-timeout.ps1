# Fix Worker Redis Timeout Issues
# This script rebuilds the worker Docker image and restarts the container

Write-Host "🔧 Fixing worker Redis timeout issues..." -ForegroundColor Yellow

# Stop the current worker
Write-Host "Stopping current worker container..." -ForegroundColor Blue
docker stop rakuten-worker 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host "Worker container not running" -ForegroundColor Gray }

docker rm rakuten-worker 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host "Worker container not found" -ForegroundColor Gray }

# Rebuild worker image
Write-Host "Rebuilding worker Docker image..." -ForegroundColor Blue
docker build -f Dockerfile.worker -t rakuten-worker .

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to build worker image" -ForegroundColor Red
    exit 1
}

# Start worker with updated configuration
Write-Host "Starting worker with fixed configuration..." -ForegroundColor Blue
docker run -d --name rakuten-worker --restart unless-stopped --env-file .env.worker rakuten-worker

if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ Worker started successfully" -ForegroundColor Green
    Write-Host "📋 Checking worker logs..." -ForegroundColor Blue
    Start-Sleep -Seconds 3
    docker logs --tail 20 rakuten-worker
} else {
    Write-Host "❌ Failed to start worker" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "🔍 Monitor worker logs with: docker logs -f rakuten-worker" -ForegroundColor Cyan
Write-Host "📊 Check worker status with: docker ps | grep rakuten-worker" -ForegroundColor Cyan