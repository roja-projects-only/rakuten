# Test coordinator with local Redis
Write-Host "Testing coordinator with local Redis..." -ForegroundColor Green

# Copy local environment
Copy-Item .env.local .env -Force
Write-Host "Switched to local Redis configuration" -ForegroundColor Yellow

# Start Redis if not running
$redisRunning = docker ps --filter "name=rakuten-redis" --format "table {{.Names}}" | Select-String "rakuten-redis"
if (-not $redisRunning) {
    Write-Host "Starting Redis..." -ForegroundColor Yellow
    docker-compose up -d redis
    Start-Sleep 5
}

# Test Redis connection
Write-Host "Testing Redis connection..." -ForegroundColor Yellow
node -e "
const { getRedisClient } = require('./shared/redis/client');
const redis = getRedisClient();
redis.connect()
  .then(() => redis.executeCommand('ping'))
  .then(result => {
    console.log('Redis PING result:', result);
    return redis.close();
  })
  .then(() => console.log('Redis connection test successful!'))
  .catch(error => {
    console.error('Redis connection test failed:', error.message);
    process.exit(1);
  });
"

if ($LASTEXITCODE -eq 0) {
    Write-Host "Redis connection successful! Starting coordinator..." -ForegroundColor Green
    Write-Host "Press Ctrl+C to stop" -ForegroundColor Yellow
    node main.js
} else {
    Write-Host "Redis connection failed. Please check Docker and try again." -ForegroundColor Red
}