@echo off
echo === Rakuten Coordinator AWS Fix ===
echo.

echo 1. Testing Redis connection...
node test-redis-connection.js
if %ERRORLEVEL% EQU 0 (
    echo    Redis connection successful!
    echo.
    echo 2. Cleaning Redis data...
    node fix-redis-data.js
    echo.
    echo 3. Checking system status...
    node check-system-status.js
    echo.
    echo 4. Starting coordinator in distributed mode...
    echo    Press Ctrl+C to stop
    echo.
    node main.js
) else (
    echo    Redis connection failed - coordinator will use single-node mode
    echo.
    echo    Starting coordinator anyway...
    echo    Press Ctrl+C to stop
    echo.
    node main.js
)