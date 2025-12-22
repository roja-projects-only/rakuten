@echo off
REM Local Redis Migration Script for Windows
REM Migrates data from old Railway Redis to new Railway Redis

echo.
echo ╔══════════════════════════════════════════════════════════════╗
echo ║                 Local Redis Migration                       ║
echo ║              Windows PowerShell Version                     ║
echo ╚══════════════════════════════════════════════════════════════╝
echo.

REM Check if Node.js is available
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js is not installed or not in PATH
    echo    Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

REM Check if we're in the right directory
if not exist "package.json" (
    echo ❌ Please run this script from the rakuten project root directory
    echo    Current directory: %CD%
    pause
    exit /b 1
)

REM Check if .env file exists
if not exist ".env" (
    echo ❌ .env file not found
    echo    Please ensure you have a .env file with REDIS_URL configured
    pause
    exit /b 1
)

echo ✅ Environment checks passed
echo.

REM Load environment variables from .env file
echo 📋 Loading configuration from .env file...
for /f "usebackq tokens=1,2 delims==" %%a in (".env") do (
    if "%%a"=="REDIS_URL" set REDIS_URL=%%b
)

if "%REDIS_URL%"=="" (
    echo ❌ REDIS_URL not found in .env file
    echo    Please add REDIS_URL to your .env file
    pause
    exit /b 1
)

echo ✅ Found REDIS_URL in .env file
echo.

REM Run the migration script
echo 🚀 Starting Redis migration...
echo.

node scripts/migrate-redis-local.js

if errorlevel 1 (
    echo.
    echo ❌ Migration failed
    pause
    exit /b 1
) else (
    echo.
    echo ✅ Migration completed successfully!
    echo.
    echo 📋 Next steps:
    echo    1. Test your application with the new Redis
    echo    2. Verify all functionality works correctly
    echo    3. Delete the old Redis instance after verification
    echo.
)

pause