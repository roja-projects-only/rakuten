@echo off
setlocal enabledelayedexpansion

REM ============================================================================
REM Rakuten Distributed System Manager
REM Manage SSH connections, logs, and containers across all instances
REM ============================================================================

title Rakuten System Manager

REM Check for SSH key
if not exist "rakuten.pem" (
    echo.
    echo ============================================================================
    echo ERROR: rakuten.pem not found in current directory
    echo ============================================================================
    echo.
    echo Please ensure rakuten.pem is in the same directory as this script.
    echo.
    pause
    exit /b 1
)

REM Define instances
set "WORKER1_IP=52.197.138.132"
set "WORKER1_NAME=worker-1"
set "WORKER1_CONTAINER=rakuten-worker"

set "WORKER2_IP=13.231.114.62"
set "WORKER2_NAME=worker-2"
set "WORKER2_CONTAINER=rakuten-worker"

set "POW_IP=35.77.110.215"
set "POW_NAME=pow-service"
set "POW_CONTAINER=rakuten-pow"

set "COORD_IP=43.207.4.202"
set "COORD_NAME=coordinator"
set "COORD_CONTAINER=rakuten-coordinator"

:menu
cls
echo.
echo ============================================================================
echo                    RAKUTEN DISTRIBUTED SYSTEM MANAGER
echo ============================================================================
echo.
echo INSTANCES:
echo   [1] worker-1      (%WORKER1_IP%)
echo   [2] worker-2      (%WORKER2_IP%)
echo   [3] pow-service   (%POW_IP%)
echo   [4] coordinator   (%COORD_IP%)
echo.
echo ACTIONS:
echo   [L] View Logs          - Open log viewer for selected instance
echo   [S] SSH Shell          - Open interactive SSH session
echo   [R] Restart Container  - Restart Docker container
echo   [T] Stop Container     - Stop Docker container
echo   [I] Instance Info      - Show container status and health
echo.
echo BULK OPERATIONS:
echo   [A] View All Logs      - Open 4 log windows
echo   [B] SSH to All         - Open 4 SSH shells
echo   [C] Check All Status   - Show status of all instances
echo   [D] Restart All        - Restart all containers
echo   [E] Stop All           - Stop all containers
echo   [F] Emergency Clear    - Clear Redis queues (coordinator only)
echo.
echo AUTO-UPDATE:
echo   [U] Update Instance    - Auto-update selected instance (stop/pull/build/run)
echo   [V] Update All         - Auto-update all instances
echo   [W] Quick Deploy       - Update + restart selected instance
echo   [X] Full Deploy        - Update + restart all instances
echo.
echo   [0] Exit
echo.
echo ============================================================================

set /p selection="Enter your choice: "

REM Convert to uppercase
for %%i in (A B C D E F L S R T I) do if /i "%selection%"=="%%i" set selection=%%i

if "%selection%"=="0" exit /b 0

REM Bulk operations
if "%selection%"=="A" goto view_all_logs
if "%selection%"=="B" goto ssh_all
if "%selection%"=="C" goto check_all_status
if "%selection%"=="D" goto restart_all
if "%selection%"=="E" goto stop_all
if "%selection%"=="F" goto emergency_clear

REM Auto-update operations
if "%selection%"=="U" goto select_instance_update
if "%selection%"=="V" goto update_all
if "%selection%"=="W" goto select_instance_quick_deploy
if "%selection%"=="X" goto full_deploy

REM Single instance operations - ask which instance
if "%selection%"=="L" goto select_instance_logs
if "%selection%"=="S" goto select_instance_ssh
if "%selection%"=="R" goto select_instance_restart
if "%selection%"=="T" goto select_instance_stop
if "%selection%"=="I" goto select_instance_info

REM Direct instance selection (1-4)
if "%selection%"=="1" (
    set "SELECTED_NAME=%WORKER1_NAME%"
    set "SELECTED_IP=%WORKER1_IP%"
    set "SELECTED_CONTAINER=%WORKER1_CONTAINER%"
    goto instance_menu
)
if "%selection%"=="2" (
    set "SELECTED_NAME=%WORKER2_NAME%"
    set "SELECTED_IP=%WORKER2_IP%"
    set "SELECTED_CONTAINER=%WORKER2_CONTAINER%"
    goto instance_menu
)
if "%selection%"=="3" (
    set "SELECTED_NAME=%POW_NAME%"
    set "SELECTED_IP=%POW_IP%"
    set "SELECTED_CONTAINER=%POW_CONTAINER%"
    goto instance_menu
)
if "%selection%"=="4" (
    set "SELECTED_NAME=%COORD_NAME%"
    set "SELECTED_IP=%COORD_IP%"
    set "SELECTED_CONTAINER=%COORD_CONTAINER%"
    goto instance_menu
)

echo.
echo Invalid selection. Please try again.
timeout /t 2 >nul
goto menu

REM ============================================================================
REM INSTANCE MENU - Actions for a specific instance
REM ============================================================================
:instance_menu
cls
echo.
echo ============================================================================
echo INSTANCE: !SELECTED_NAME! ^(!SELECTED_IP!^)
echo ============================================================================
echo.
echo   [L] View Logs
echo   [S] SSH Shell
echo   [R] Restart Container
echo   [T] Stop Container
echo   [I] Instance Info
echo   [U] Update Instance     - Auto-update (stop/pull/build/run)
echo   [Q] Quick Deploy        - Fast update and restart
echo   [B] Back to Main Menu
echo.
set /p action="Select action: "

for %%i in (L S R T I U Q B) do if /i "!action!"=="%%i" set action=%%i

if "!action!"=="B" goto menu
if "!action!"=="L" goto view_logs
if "!action!"=="S" goto ssh_shell
if "!action!"=="R" goto restart_container
if "!action!"=="T" goto stop_container
if "!action!"=="I" goto instance_info
if "!action!"=="U" (set "SELECTED_DOCKERFILE=Dockerfile.worker" & if "!SELECTED_NAME!"=="pow-service" set "SELECTED_DOCKERFILE=Dockerfile.pow-service" & if "!SELECTED_NAME!"=="coordinator" set "SELECTED_DOCKERFILE=Dockerfile.coordinator" & goto update_instance)
if "!action!"=="Q" (set "SELECTED_DOCKERFILE=Dockerfile.worker" & if "!SELECTED_NAME!"=="pow-service" set "SELECTED_DOCKERFILE=Dockerfile.pow-service" & if "!SELECTED_NAME!"=="coordinator" set "SELECTED_DOCKERFILE=Dockerfile.coordinator" & goto quick_deploy_instance)

echo Invalid action.
timeout /t 2 >nul
goto instance_menu

REM ============================================================================
REM SINGLE INSTANCE OPERATIONS
REM ============================================================================

:select_instance_logs
echo.
echo Select instance (1-4): 
set /p inst="Instance: "
if "%inst%"=="1" (set "SELECTED_NAME=%WORKER1_NAME%" & set "SELECTED_IP=%WORKER1_IP%" & set "SELECTED_CONTAINER=%WORKER1_CONTAINER%")
if "%inst%"=="2" (set "SELECTED_NAME=%WORKER2_NAME%" & set "SELECTED_IP=%WORKER2_IP%" & set "SELECTED_CONTAINER=%WORKER2_CONTAINER%")
if "%inst%"=="3" (set "SELECTED_NAME=%POW_NAME%" & set "SELECTED_IP=%POW_IP%" & set "SELECTED_CONTAINER=%POW_CONTAINER%")
if "%inst%"=="4" (set "SELECTED_NAME=%COORD_NAME%" & set "SELECTED_IP=%COORD_IP%" & set "SELECTED_CONTAINER=%COORD_CONTAINER%")
goto view_logs

:select_instance_ssh
echo.
echo Select instance (1-4): 
set /p inst="Instance: "
if "%inst%"=="1" (set "SELECTED_NAME=%WORKER1_NAME%" & set "SELECTED_IP=%WORKER1_IP%" & set "SELECTED_CONTAINER=%WORKER1_CONTAINER%")
if "%inst%"=="2" (set "SELECTED_NAME=%WORKER2_NAME%" & set "SELECTED_IP=%WORKER2_IP%" & set "SELECTED_CONTAINER=%WORKER2_CONTAINER%")
if "%inst%"=="3" (set "SELECTED_NAME=%POW_NAME%" & set "SELECTED_IP=%POW_IP%" & set "SELECTED_CONTAINER=%POW_CONTAINER%")
if "%inst%"=="4" (set "SELECTED_NAME=%COORD_NAME%" & set "SELECTED_IP=%COORD_IP%" & set "SELECTED_CONTAINER=%COORD_CONTAINER%")
goto ssh_shell

:select_instance_restart
echo.
echo Select instance (1-4): 
set /p inst="Instance: "
if "%inst%"=="1" (set "SELECTED_NAME=%WORKER1_NAME%" & set "SELECTED_IP=%WORKER1_IP%" & set "SELECTED_CONTAINER=%WORKER1_CONTAINER%")
if "%inst%"=="2" (set "SELECTED_NAME=%WORKER2_NAME%" & set "SELECTED_IP=%WORKER2_IP%" & set "SELECTED_CONTAINER=%WORKER2_CONTAINER%")
if "%inst%"=="3" (set "SELECTED_NAME=%POW_NAME%" & set "SELECTED_IP=%POW_IP%" & set "SELECTED_CONTAINER=%POW_CONTAINER%")
if "%inst%"=="4" (set "SELECTED_NAME=%COORD_NAME%" & set "SELECTED_IP=%COORD_IP%" & set "SELECTED_CONTAINER=%COORD_CONTAINER%")
goto restart_container

:select_instance_stop
echo.
echo Select instance (1-4): 
set /p inst="Instance: "
if "%inst%"=="1" (set "SELECTED_NAME=%WORKER1_NAME%" & set "SELECTED_IP=%WORKER1_IP%" & set "SELECTED_CONTAINER=%WORKER1_CONTAINER%")
if "%inst%"=="2" (set "SELECTED_NAME=%WORKER2_NAME%" & set "SELECTED_IP=%WORKER2_IP%" & set "SELECTED_CONTAINER=%WORKER2_CONTAINER%")
if "%inst%"=="3" (set "SELECTED_NAME=%POW_NAME%" & set "SELECTED_IP=%POW_IP%" & set "SELECTED_CONTAINER=%POW_CONTAINER%")
if "%inst%"=="4" (set "SELECTED_NAME=%COORD_NAME%" & set "SELECTED_IP=%COORD_IP%" & set "SELECTED_CONTAINER=%COORD_CONTAINER%")
goto stop_container

:select_instance_info
echo.
echo Select instance (1-4): 
set /p inst="Instance: "
if "%inst%"=="1" (set "SELECTED_NAME=%WORKER1_NAME%" & set "SELECTED_IP=%WORKER1_IP%" & set "SELECTED_CONTAINER=%WORKER1_CONTAINER%")
if "%inst%"=="2" (set "SELECTED_NAME=%WORKER2_NAME%" & set "SELECTED_IP=%WORKER2_IP%" & set "SELECTED_CONTAINER=%WORKER2_CONTAINER%")
if "%inst%"=="3" (set "SELECTED_NAME=%POW_NAME%" & set "SELECTED_IP=%POW_IP%" & set "SELECTED_CONTAINER=%POW_CONTAINER%")
if "%inst%"=="4" (set "SELECTED_NAME=%COORD_NAME%" & set "SELECTED_IP=%COORD_IP%" & set "SELECTED_CONTAINER=%COORD_CONTAINER%")
goto instance_info

:view_logs
echo.
echo Opening logs for !SELECTED_NAME!...
start "!SELECTED_NAME! - Logs" cmd /k "ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@!SELECTED_IP! docker logs -f --tail=100 !SELECTED_CONTAINER!"
echo.
echo Log window opened!
timeout /t 2 >nul
goto menu

:ssh_shell
echo.
echo Opening SSH shell for !SELECTED_NAME!...
start "!SELECTED_NAME! - SSH" cmd /k "ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@!SELECTED_IP!"
echo.
echo SSH window opened!
timeout /t 2 >nul
goto menu

:restart_container
echo.
echo Restarting !SELECTED_NAME! container...
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@!SELECTED_IP! "docker restart !SELECTED_CONTAINER!"
if errorlevel 1 (
    echo ERROR: Failed to restart container
) else (
    echo SUCCESS: Container restarted
)
echo.
pause
goto menu

:stop_container
echo.
echo WARNING: This will stop the !SELECTED_NAME! container.
set /p confirm="Are you sure? (Y/N): "
if /i not "!confirm!"=="Y" goto menu
echo.
echo Stopping !SELECTED_NAME! container...
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@!SELECTED_IP! "docker stop !SELECTED_CONTAINER!"
if errorlevel 1 (
    echo ERROR: Failed to stop container
) else (
    echo SUCCESS: Container stopped
)
echo.
pause
goto menu

:instance_info
echo.
echo ============================================================================
echo INSTANCE INFO: !SELECTED_NAME! ^(!SELECTED_IP!^)
echo ============================================================================
echo.
echo Container Status:
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@!SELECTED_IP! "docker ps -a --filter name=!SELECTED_CONTAINER! --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'"
echo.
echo Recent Logs (last 20 lines):
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@!SELECTED_IP! "docker logs --tail=20 !SELECTED_CONTAINER!"
echo.
pause
goto menu

REM ============================================================================
REM BULK OPERATIONS
REM ============================================================================

:view_all_logs
echo.
echo Opening all log windows...
start "worker-1 - Logs" cmd /k "ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%WORKER1_IP% docker logs -f --tail=100 %WORKER1_CONTAINER%"
start "worker-2 - Logs" cmd /k "ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%WORKER2_IP% docker logs -f --tail=100 %WORKER2_CONTAINER%"
start "pow-service - Logs" cmd /k "ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%POW_IP% docker logs -f --tail=100 %POW_CONTAINER%"
start "coordinator - Logs" cmd /k "ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%COORD_IP% docker logs -f --tail=100 %COORD_CONTAINER%"
echo.
echo All log windows opened!
timeout /t 2 >nul
goto menu

:ssh_all
echo.
echo Opening SSH shells for all instances...
start "worker-1 - SSH" cmd /k "ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%WORKER1_IP%"
start "worker-2 - SSH" cmd /k "ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%WORKER2_IP%"
start "pow-service - SSH" cmd /k "ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%POW_IP%"
start "coordinator - SSH" cmd /k "ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%COORD_IP%"
echo.
echo All SSH windows opened!
timeout /t 2 >nul
goto menu

:check_all_status
echo.
echo ============================================================================
echo CHECKING ALL INSTANCES
echo ============================================================================
echo.
echo [1/4] worker-1 (%WORKER1_IP%):
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%WORKER1_IP% "docker ps -a --filter name=%WORKER1_CONTAINER% --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'"
echo.
echo [2/4] worker-2 (%WORKER2_IP%):
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%WORKER2_IP% "docker ps -a --filter name=%WORKER2_CONTAINER% --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'"
echo.
echo [3/4] pow-service (%POW_IP%):
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%POW_IP% "docker ps -a --filter name=%POW_CONTAINER% --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'"
echo.
echo [4/4] coordinator (%COORD_IP%):
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%COORD_IP% "docker ps -a --filter name=%COORD_CONTAINER% --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'"
echo.
echo ============================================================================
pause
goto menu

:restart_all
echo.
echo WARNING: This will restart ALL containers.
set /p confirm="Are you sure? (Y/N): "
if /i not "!confirm!"=="Y" goto menu
echo.
echo Restarting all containers...
echo.
echo [1/4] Restarting worker-1...
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%WORKER1_IP% "docker restart %WORKER1_CONTAINER%"
echo [2/4] Restarting worker-2...
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%WORKER2_IP% "docker restart %WORKER2_CONTAINER%"
echo [3/4] Restarting pow-service...
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%POW_IP% "docker restart %POW_CONTAINER%"
echo [4/4] Restarting coordinator...
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%COORD_IP% "docker restart %COORD_CONTAINER%"
echo.
echo All containers restarted!
pause
goto menu

:stop_all
echo.
echo WARNING: This will STOP ALL containers.
set /p confirm="Are you sure? (Y/N): "
if /i not "!confirm!"=="Y" goto menu
echo.
echo Stopping all containers...
echo.
echo [1/4] Stopping worker-1...
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%WORKER1_IP% "docker stop %WORKER1_CONTAINER%"
echo [2/4] Stopping worker-2...
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%WORKER2_IP% "docker stop %WORKER2_CONTAINER%"
echo [3/4] Stopping pow-service...
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%POW_IP% "docker stop %POW_CONTAINER%"
echo [4/4] Stopping coordinator...
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%COORD_IP% "docker stop %COORD_CONTAINER%"
echo.
echo All containers stopped!
pause
goto menu

:emergency_clear
echo.
echo ============================================================================
echo EMERGENCY REDIS CLEAR
echo ============================================================================
echo.
echo This will clear all Redis queues and stuck batches.
echo Use this when batch processing is stuck or taking too long.
echo.
set /p confirm="Are you sure? (Y/N): "
if /i not "!confirm!"=="Y" goto menu
echo.
echo Running emergency clear script...
node emergency-clear-redis.js
if errorlevel 1 (
    echo.
    echo ERROR: Emergency clear failed. Check if Node.js is installed.
) else (
    echo.
    echo SUCCESS: Redis queues cleared!
)
echo.
pause
goto menu

REM ============================================================================
REM AUTO-UPDATE OPERATIONS
REM ============================================================================

:select_instance_update
echo.
echo Select instance to update (1-4): 
set /p inst="Instance: "
if "%inst%"=="1" (set "SELECTED_NAME=%WORKER1_NAME%" & set "SELECTED_IP=%WORKER1_IP%" & set "SELECTED_CONTAINER=%WORKER1_CONTAINER%" & set "SELECTED_DOCKERFILE=Dockerfile.worker")
if "%inst%"=="2" (set "SELECTED_NAME=%WORKER2_NAME%" & set "SELECTED_IP=%WORKER2_IP%" & set "SELECTED_CONTAINER=%WORKER2_CONTAINER%" & set "SELECTED_DOCKERFILE=Dockerfile.worker")
if "%inst%"=="3" (set "SELECTED_NAME=%POW_NAME%" & set "SELECTED_IP=%POW_IP%" & set "SELECTED_CONTAINER=%POW_CONTAINER%" & set "SELECTED_DOCKERFILE=Dockerfile.pow-service")
if "%inst%"=="4" (set "SELECTED_NAME=%COORD_NAME%" & set "SELECTED_IP=%COORD_IP%" & set "SELECTED_CONTAINER=%COORD_CONTAINER%" & set "SELECTED_DOCKERFILE=Dockerfile.coordinator")
goto update_instance

:select_instance_quick_deploy
echo.
echo Select instance for quick deploy (1-4): 
set /p inst="Instance: "
if "%inst%"=="1" (set "SELECTED_NAME=%WORKER1_NAME%" & set "SELECTED_IP=%WORKER1_IP%" & set "SELECTED_CONTAINER=%WORKER1_CONTAINER%" & set "SELECTED_DOCKERFILE=Dockerfile.worker")
if "%inst%"=="2" (set "SELECTED_NAME=%WORKER2_NAME%" & set "SELECTED_IP=%WORKER2_IP%" & set "SELECTED_CONTAINER=%WORKER2_CONTAINER%" & set "SELECTED_DOCKERFILE=Dockerfile.worker")
if "%inst%"=="3" (set "SELECTED_NAME=%POW_NAME%" & set "SELECTED_IP=%POW_IP%" & set "SELECTED_CONTAINER=%POW_CONTAINER%" & set "SELECTED_DOCKERFILE=Dockerfile.pow-service")
if "%inst%"=="4" (set "SELECTED_NAME=%COORD_NAME%" & set "SELECTED_IP=%COORD_IP%" & set "SELECTED_CONTAINER=%COORD_CONTAINER%" & set "SELECTED_DOCKERFILE=Dockerfile.coordinator")
goto quick_deploy_instance

:update_instance
echo.
echo ============================================================================
echo AUTO-UPDATE: !SELECTED_NAME! ^(!SELECTED_IP!^)
echo ============================================================================
echo.
echo This will:
echo   1. Stop and remove the current container
echo   2. Pull latest code from git
echo   3. Build new Docker image
echo   4. Run new container
echo   5. Show logs
echo.
set /p confirm="Continue with update? (Y/N): "
if /i not "!confirm!"=="Y" goto menu
echo.
echo [1/5] Stopping and removing container...
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@!SELECTED_IP! "docker stop !SELECTED_CONTAINER! 2>/dev/null || true && docker rm !SELECTED_CONTAINER! 2>/dev/null || true"
echo.
echo [2/5] Pulling latest code...
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@!SELECTED_IP! "cd /opt/rakuten-checker && git pull origin main"
if errorlevel 1 (
    echo ERROR: Failed to pull latest code
    pause
    goto menu
)
echo.
echo [3/5] Building Docker image...
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@!SELECTED_IP! "cd /opt/rakuten-checker && docker build -f !SELECTED_DOCKERFILE! -t rakuten-!SELECTED_NAME! ."
if errorlevel 1 (
    echo ERROR: Failed to build Docker image
    pause
    goto menu
)
echo.
echo [4/5] Starting new container...
call :start_container_by_type !SELECTED_NAME! !SELECTED_IP! !SELECTED_CONTAINER!
if errorlevel 1 (
    echo ERROR: Failed to start container
    pause
    goto menu
)
echo.
echo [5/5] Showing logs...
echo Container started successfully! Opening logs...
timeout /t 3 >nul
start "!SELECTED_NAME! - Update Logs" cmd /k "ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@!SELECTED_IP! docker logs -f --tail=50 !SELECTED_CONTAINER!"
echo.
echo SUCCESS: !SELECTED_NAME! updated successfully!
pause
goto menu

:quick_deploy_instance
echo.
echo ============================================================================
echo QUICK DEPLOY: !SELECTED_NAME! ^(!SELECTED_IP!^)
echo ============================================================================
echo.
echo This will update and restart the instance quickly.
echo.
set /p confirm="Continue with quick deploy? (Y/N): "
if /i not "!confirm!"=="Y" goto menu
echo.
echo Performing quick deploy...
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@!SELECTED_IP! "cd /opt/rakuten-checker && git pull origin main && docker stop !SELECTED_CONTAINER! 2>/dev/null || true && docker rm !SELECTED_CONTAINER! 2>/dev/null || true && docker build -f !SELECTED_DOCKERFILE! -t rakuten-!SELECTED_NAME! . && echo 'Build complete, starting container...'"
if errorlevel 1 (
    echo ERROR: Quick deploy failed
    pause
    goto menu
)
call :start_container_by_type !SELECTED_NAME! !SELECTED_IP! !SELECTED_CONTAINER!
echo.
echo SUCCESS: Quick deploy completed!
start "!SELECTED_NAME! - Deploy Logs" cmd /k "ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@!SELECTED_IP! docker logs -f --tail=30 !SELECTED_CONTAINER!"
pause
goto menu

:update_all
echo.
echo ============================================================================
echo UPDATE ALL INSTANCES
echo ============================================================================
echo.
echo This will update all 4 instances:
echo   - worker-1, worker-2, pow-service, coordinator
echo.
echo WARNING: This may take 10-15 minutes to complete.
set /p confirm="Continue with full update? (Y/N): "
if /i not "!confirm!"=="Y" goto menu
echo.
echo Starting update process...
echo.

REM Update worker-1
echo [1/4] Updating worker-1...
set "SELECTED_NAME=%WORKER1_NAME%"
set "SELECTED_IP=%WORKER1_IP%"
set "SELECTED_CONTAINER=%WORKER1_CONTAINER%"
set "SELECTED_DOCKERFILE=Dockerfile.worker"
call :perform_update
echo.

REM Update worker-2
echo [2/4] Updating worker-2...
set "SELECTED_NAME=%WORKER2_NAME%"
set "SELECTED_IP=%WORKER2_IP%"
set "SELECTED_CONTAINER=%WORKER2_CONTAINER%"
set "SELECTED_DOCKERFILE=Dockerfile.worker"
call :perform_update
echo.

REM Update pow-service
echo [3/4] Updating pow-service...
set "SELECTED_NAME=%POW_NAME%"
set "SELECTED_IP=%POW_IP%"
set "SELECTED_CONTAINER=%POW_CONTAINER%"
set "SELECTED_DOCKERFILE=Dockerfile.pow-service"
call :perform_update
echo.

REM Update coordinator
echo [4/4] Updating coordinator...
set "SELECTED_NAME=%COORD_NAME%"
set "SELECTED_IP=%COORD_IP%"
set "SELECTED_CONTAINER=%COORD_CONTAINER%"
set "SELECTED_DOCKERFILE=Dockerfile.coordinator"
call :perform_update
echo.

echo ============================================================================
echo ALL UPDATES COMPLETED!
echo ============================================================================
echo Opening all log windows...
start "worker-1 - Update Logs" cmd /k "ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%WORKER1_IP% docker logs -f --tail=30 %WORKER1_CONTAINER%"
start "worker-2 - Update Logs" cmd /k "ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%WORKER2_IP% docker logs -f --tail=30 %WORKER2_CONTAINER%"
start "pow-service - Update Logs" cmd /k "ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%POW_IP% docker logs -f --tail=30 %POW_CONTAINER%"
start "coordinator - Update Logs" cmd /k "ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@%COORD_IP% docker logs -f --tail=30 %COORD_CONTAINER%"
pause
goto menu

:full_deploy
echo.
echo ============================================================================
echo FULL DEPLOY - UPDATE AND RESTART ALL
echo ============================================================================
echo.
echo This will perform a complete deployment:
echo   1. Update all instances with latest code
echo   2. Rebuild all Docker images
echo   3. Restart all containers
echo   4. Show all logs
echo.
echo WARNING: This will cause temporary downtime for all services.
set /p confirm="Continue with full deploy? (Y/N): "
if /i not "!confirm!"=="Y" goto menu
echo.
echo Starting full deployment...
call :update_all
echo.
echo FULL DEPLOY COMPLETED!
pause
goto menu

REM ============================================================================
REM HELPER FUNCTIONS FOR AUTO-UPDATE
REM ============================================================================

:perform_update
echo   Stopping container: !SELECTED_NAME!
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@!SELECTED_IP! "docker stop !SELECTED_CONTAINER! 2>/dev/null || true && docker rm !SELECTED_CONTAINER! 2>/dev/null || true"
echo   Pulling latest code: !SELECTED_NAME!
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@!SELECTED_IP! "cd /opt/rakuten-checker && git pull origin main"
echo   Building image: !SELECTED_NAME!
ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@!SELECTED_IP! "cd /opt/rakuten-checker && docker build -f !SELECTED_DOCKERFILE! -t rakuten-!SELECTED_NAME! ."
echo   Starting container: !SELECTED_NAME!
call :start_container_by_type !SELECTED_NAME! !SELECTED_IP! !SELECTED_CONTAINER!
echo   SUCCESS: !SELECTED_NAME! updated
goto :eof

:start_container_by_type
set "TYPE_NAME=%~1"
set "TYPE_IP=%~2"
set "TYPE_CONTAINER=%~3"

if "!TYPE_NAME!"=="worker-1" (
    ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@!TYPE_IP! "docker run -d --name !TYPE_CONTAINER! --restart unless-stopped --env-file /opt/rakuten-checker/.env.worker rakuten-!TYPE_NAME!"
) else if "!TYPE_NAME!"=="worker-2" (
    ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@!TYPE_IP! "docker run -d --name !TYPE_CONTAINER! --restart unless-stopped --env-file /opt/rakuten-checker/.env.worker rakuten-!TYPE_NAME!"
) else if "!TYPE_NAME!"=="pow-service" (
    ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@!TYPE_IP! "docker run -d --name !TYPE_CONTAINER! --restart unless-stopped -p 8080:8080 -p 9090:9090 --env-file /opt/rakuten-checker/.env.pow-service rakuten-!TYPE_NAME!"
) else if "!TYPE_NAME!"=="coordinator" (
    ssh -i rakuten.pem -o StrictHostKeyChecking=no ubuntu@!TYPE_IP! "docker run -d --name !TYPE_CONTAINER! --restart unless-stopped -p 9090:9090 --env-file /opt/rakuten-checker/.env.coordinator rakuten-!TYPE_NAME!"
)
goto :eof