@echo off
REM EC2 Instance Deployment Script for Windows
REM Automatically updates chosen EC2 instances with latest repository code

echo.
echo ╔══════════════════════════════════════════════════════════════╗
echo ║                EC2 Instance Deployment Tool                 ║
echo ║              Windows Command Line Version                   ║
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

REM Check if SSH key exists
if not exist "rakuten.pem" (
    echo ❌ SSH key not found: rakuten.pem
    echo    Please ensure rakuten.pem is in the project root directory
    pause
    exit /b 1
)

echo ✅ Environment checks passed
echo.

REM Run the deployment script
echo 🚀 Starting instance deployment tool...
echo.

node scripts/deploy-instances.js

if errorlevel 1 (
    echo.
    echo ❌ Deployment failed
    pause
    exit /b 1
) else (
    echo.
    echo ✅ Deployment process completed!
    echo    Check the results above for individual instance status
    echo.
)

pause