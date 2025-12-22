@echo off
echo Killing processes using port 9090...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :9090') do (
    echo Killing process %%a
    taskkill /f /pid %%a 2>nul
)
echo Done!