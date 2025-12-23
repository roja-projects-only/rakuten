# Fix Coordinator Issue on AWS EC2
Write-Host "=== Rakuten Coordinator AWS Fix ===" -ForegroundColor Cyan
Write-Host ""

# Step 1: Test current Redis connection
Write-Host "1. Testing current Redis connection..." -ForegroundColor Yellow

# Load environment variables from .env file
$envVars = @{}
if (Test-Path ".env") {
    Get-Content ".env" | ForEach-Object {
        if ($_ -match "^([^#][^=]+)=(.*)$") {
            $key = $matches[1].Trim()
            $value = $matches[2].Trim()
            $envVars[$key] = $value
            [Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
    Write-Host "   Loaded environment variables from .env" -ForegroundColor Green
} else {
    Write-Host "   No .env file found" -ForegroundColor Red
    exit 1
}

# Test Redis connection
Write-Host "   Testing Redis connection..." -ForegroundColor Gray
$testResult = node test-redis-connection.js 2>&1
$redisWorking = $LASTEXITCODE -eq 0

if ($redisWorking) {
    Write-Host "   ✓ Redis connection successful" -ForegroundColor Green
} else {
    Write-Host "   ✗ Redis connection failed" -ForegroundColor Red
    Write-Host "   Output: $testResult" -ForegroundColor Gray
    
    # Try to diagnose the issue
    Write-Host ""
    Write-Host "   Diagnosing Redis connection issue..." -ForegroundColor Yellow
    
    if ($envVars.ContainsKey("REDIS_URL")) {
        Write-Host "   REDIS_URL is set: $($envVars['REDIS_URL'])" -ForegroundColor Gray
        
        # Test if it's a network connectivity issue
        $redisHost = ($envVars['REDIS_URL'] -replace "redis://[^@]*@", "" -split ":")[0]
        Write-Host "   Testing connectivity to Redis host: $redisHost" -ForegroundColor Gray
        
        try {
            $testConnection = Test-NetConnection -ComputerName $redisHost -Port 36224 -WarningAction SilentlyContinue
            if ($testConnection.TcpTestSucceeded) {
                Write-Host "   ✓ Network connectivity to Redis host is working" -ForegroundColor Green
                Write-Host "   The issue might be with Redis authentication or configuration" -ForegroundColor Yellow
            } else {
                Write-Host "   ✗ Cannot reach Redis host from this EC2 instance" -ForegroundColor Red
                Write-Host "   This explains why the coordinator falls back to single-node mode" -ForegroundColor Yellow
            }
        } catch {
            Write-Host "   Could not test network connectivity" -ForegroundColor Gray
        }
    } else {
        Write-Host "   REDIS_URL is not set in environment" -ForegroundColor Red
    }
}

# Step 2: Clean any problematic Redis data if connection works
if ($redisWorking) {
    Write-Host ""
    Write-Host "2. Cleaning problematic Redis data..." -ForegroundColor Yellow
    node fix-redis-data.js
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   ✓ Redis cleanup completed" -ForegroundColor Green
    } else {
        Write-Host "   ⚠ Redis cleanup had issues, but continuing..." -ForegroundColor Yellow
    }
}

# Step 3: Check system status
Write-Host ""
Write-Host "3. Checking distributed system status..." -ForegroundColor Yellow
node check-system-status.js

# Step 4: Provide recommendations
Write-Host ""
Write-Host "=== RECOMMENDATIONS ===" -ForegroundColor Cyan

if ($redisWorking) {
    Write-Host "✓ Redis is working - the coordinator should use distributed mode" -ForegroundColor Green
    Write-Host ""
    Write-Host "To start the coordinator with proper environment:" -ForegroundColor Yellow
    Write-Host "   node main.js" -ForegroundColor White
    Write-Host ""
    Write-Host "The coordinator should now:" -ForegroundColor Gray
    Write-Host "   - Connect to Redis successfully" -ForegroundColor Gray
    Write-Host "   - Use distributed worker mode instead of single-node fallback" -ForegroundColor Gray
    Write-Host "   - Process batches using the worker instances" -ForegroundColor Gray
} else {
    Write-Host "✗ Redis connection is failing" -ForegroundColor Red
    Write-Host ""
    Write-Host "Options to fix this:" -ForegroundColor Yellow
    Write-Host "1. Set up Redis on your EC2 infrastructure:" -ForegroundColor White
    Write-Host "   - Install Redis on one of your EC2 instances" -ForegroundColor Gray
    Write-Host "   - Update REDIS_URL to point to your EC2 Redis instance" -ForegroundColor Gray
    Write-Host ""
    Write-Host "2. Use AWS ElastiCache Redis:" -ForegroundColor White
    Write-Host "   - Create an ElastiCache Redis cluster" -ForegroundColor Gray
    Write-Host "   - Update REDIS_URL to point to ElastiCache endpoint" -ForegroundColor Gray
    Write-Host ""
    Write-Host "3. Fix Railway Redis connectivity:" -ForegroundColor White
    Write-Host "   - Check if Railway Redis allows connections from your EC2 IP" -ForegroundColor Gray
    Write-Host "   - Verify Redis credentials are still valid" -ForegroundColor Gray
    Write-Host ""
    Write-Host "4. Run in single-node mode (current fallback):" -ForegroundColor White
    Write-Host "   - Remove or comment out REDIS_URL in .env" -ForegroundColor Gray
    Write-Host "   - The coordinator will use in-memory processing" -ForegroundColor Gray
    Write-Host "   - Workers won't be used, but basic functionality works" -ForegroundColor Gray
}

Write-Host ""