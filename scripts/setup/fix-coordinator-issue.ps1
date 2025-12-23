# Fix Coordinator Issue - Complete Solution
Write-Host "=== Rakuten Coordinator Issue Fix ===" -ForegroundColor Cyan
Write-Host ""

# Step 1: Check current environment
Write-Host "1. Checking current environment..." -ForegroundColor Yellow
$currentRedisUrl = $env:REDIS_URL
if ($currentRedisUrl) {
    Write-Host "   Current REDIS_URL: $currentRedisUrl" -ForegroundColor Gray
} else {
    Write-Host "   No REDIS_URL set in environment" -ForegroundColor Gray
}

# Step 2: Start local Redis
Write-Host ""
Write-Host "2. Starting local Redis..." -ForegroundColor Yellow
$redisRunning = docker ps --filter "name=rakuten-redis" --format "table {{.Names}}" | Select-String "rakuten-redis"
if ($redisRunning) {
    Write-Host "   Redis already running" -ForegroundColor Green
} else {
    Write-Host "   Starting Redis container..." -ForegroundColor Gray
    docker-compose up -d redis
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   Redis started successfully" -ForegroundColor Green
        Start-Sleep 3
    } else {
        Write-Host "   Failed to start Redis" -ForegroundColor Red
        exit 1
    }
}

# Step 3: Switch to local configuration
Write-Host ""
Write-Host "3. Switching to local Redis configuration..." -ForegroundColor Yellow
Copy-Item .env.local .env -Force
Write-Host "   Configuration updated to use localhost:6379" -ForegroundColor Green

# Step 4: Clean Redis data
Write-Host ""
Write-Host "4. Cleaning problematic Redis data..." -ForegroundColor Yellow
node fix-redis-data.js
if ($LASTEXITCODE -eq 0) {
    Write-Host "   Redis cleanup completed" -ForegroundColor Green
} else {
    Write-Host "   Redis cleanup failed, but continuing..." -ForegroundColor Yellow
}

# Step 5: Test Redis connection
Write-Host ""
Write-Host "5. Testing Redis connection..." -ForegroundColor Yellow
$testResult = node -e "
const { getRedisClient } = require('./shared/redis/client');
const redis = getRedisClient();
redis.connect()
  .then(() => redis.executeCommand('ping'))
  .then(result => {
    console.log('PING result:', result);
    return redis.close();
  })
  .then(() => {
    console.log('SUCCESS');
    process.exit(0);
  })
  .catch(error => {
    console.error('FAILED:', error.message);
    process.exit(1);
  });
" 2>&1

if ($LASTEXITCODE -eq 0) {
    Write-Host "   Redis connection test passed" -ForegroundColor Green
} else {
    Write-Host "   Redis connection test failed:" -ForegroundColor Red
    Write-Host "   $testResult" -ForegroundColor Red
    exit 1
}

# Step 6: Start coordinator
Write-Host ""
Write-Host "6. Starting coordinator in distributed mode..." -ForegroundColor Yellow
Write-Host "   The coordinator should now use workers instead of single-node mode" -ForegroundColor Gray
Write-Host "   Press Ctrl+C to stop" -ForegroundColor Cyan
Write-Host ""

# Set environment variable for this session
$env:REDIS_URL = "redis://localhost:6379"

# Start the coordinator
node main.js