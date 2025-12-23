# Debug script for Rakuten Dashboard connection
param(
    [string]$ApiKey = "03ef2ee58c8aca6a0d2d707003eaca585d14e667f7112ad56537eea684dfb7b8",
    [string]$BaseUrl = "https://rakutena.vercel.app"
)

Write-Host "Debug Rakuten Dashboard Connection" -ForegroundColor Cyan
Write-Host "Base URL: $BaseUrl" -ForegroundColor Yellow
Write-Host "API Key: $($ApiKey.Substring(0,8))..." -ForegroundColor Yellow
Write-Host ""

# Test endpoints
$endpoints = @(
    "/api/health",
    "/api/metrics", 
    "/api/config",
    "/api/analytics",
    "/api/proxy",
    "/api/reports",
    "/api/alerts"
)

foreach ($endpoint in $endpoints) {
    Write-Host "Testing $endpoint..." -ForegroundColor White
    
    try {
        $response = Invoke-WebRequest -Uri "$BaseUrl$endpoint" -Headers @{"X-API-Key"=$ApiKey} -UseBasicParsing -TimeoutSec 10
        
        if ($response.StatusCode -eq 200) {
            Write-Host "  SUCCESS (200)" -ForegroundColor Green
            
            # Try to parse JSON response
            try {
                $json = $response.Content | ConvertFrom-Json
                if ($json.error) {
                    Write-Host "  Response contains error: $($json.error.message)" -ForegroundColor Yellow
                } else {
                    Write-Host "  Response looks good" -ForegroundColor Green
                }
            } catch {
                Write-Host "  Non-JSON response" -ForegroundColor Gray
            }
        } else {
            Write-Host "  HTTP $($response.StatusCode)" -ForegroundColor Red
        }
    } catch {
        try {
            $statusCode = $_.Exception.Response.StatusCode.value__
            if ($statusCode -eq 401) {
                Write-Host "  UNAUTHORIZED (401) - Check API key" -ForegroundColor Red
            } elseif ($statusCode -eq 429) {
                Write-Host "  RATE LIMITED (429) - Wait 15 minutes" -ForegroundColor Yellow
            } elseif ($statusCode -eq 500) {
                Write-Host "  SERVER ERROR (500)" -ForegroundColor Red
            } else {
                Write-Host "  HTTP $statusCode" -ForegroundColor Red
            }
        } catch {
            Write-Host "  ERROR: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
    
    Start-Sleep -Milliseconds 500
}

Write-Host ""
Write-Host "Next Steps:" -ForegroundColor Cyan
Write-Host "1. If you see 429 errors, wait 15 minutes for rate limit to reset"
Write-Host "2. If you see 401 errors, check your Vercel environment variables"
Write-Host "3. If you see 500 errors, check Vercel function logs"
Write-Host ""
Write-Host "Vercel Environment Setup:"
Write-Host "1. Go to https://vercel.com/dashboard"
Write-Host "2. Select your 'rakutena' project"
Write-Host "3. Go to Settings -> Environment Variables"
Write-Host "4. Ensure these are set for Production:"
Write-Host "   DASHBOARD_API_KEY = $ApiKey"
Write-Host "   COORDINATOR_REDIS_URL = redis://default:AxyIJiltXdrbkgpvhoexVgNBIRzlrXpU@hopper.proxy.rlwy.net:36224"
Write-Host "   COORDINATOR_METRICS_URL = http://YOUR_COORDINATOR_PUBLIC_IP:9090/metrics"
Write-Host "5. Redeploy after setting environment variables"