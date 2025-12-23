# Fix Coordinator Issue on AWS EC2 - Simple Version
Write-Host "=== Rakuten Coordinator AWS Fix ===" -ForegroundColor Cyan
Write-Host ""

# Step 1: Load environment variables from .env file
Write-Host "1. Loading environment variables..." -ForegroundColor Yellow

if (Test-Path ".env") {
    Get-Content ".env" | ForEach-Object {
        if ($_ -match "^([^#][^=]+)=(.*)$") {
            $key = $matches[1].Trim()
            $value = $matches[2].Trim()
            [Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
    Write-Host "   ✓ Environment variables loaded from .env" -ForegroundColor Green
} else {
    Write-Host "   ✗ No .env file found" -ForegroundColor Red
    exit 1
}

# Step 2: Test Redis connection
Write-Host ""
Write-Host "2. Testing Redis connection..." -ForegroundColor Yellow
node test-redis-connection.js
$redisWorking = $LASTEXITCODE -eq 0

# Step 3: Clean Redis data if connection works
if ($redisWorking) {
    Write-Host ""
    Write-Host "3. Cleaning problematic Redis data..." -ForegroundColor Yellow
    node fix-redis-data.js
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   ✓ Redis cleanup completed" -ForegroundColor Green
    }
}

# Step 4: Check system status
Write-Host ""
Write-Host "4. Checking distributed system status..." -ForegroundColor Yellow
node check-system-status.js

# Step 5: Start coordinator with proper environment
Write-Host ""
Write-Host "5. Starting coordinator..." -ForegroundColor Yellow

if ($redisWorking) {
    Write-Host "   Redis is working - coordinator should use distributed mode" -ForegroundColor Green
} else {
    Write-Host "   Redis failed - coordinator will use single-node fallback mode" -ForegroundColor Yellow
}

Write-Host "   Press Ctrl+C to stop" -ForegroundColor Cyan
Write-Host ""

# Start the coordinator
node main.js