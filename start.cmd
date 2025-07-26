@echo off
REM Otedama Quick Start for Windows
REM Automatically detects best mode and starts the pool

echo ===============================================
echo  Otedama Mining Pool
echo  Version 1.1.1 - Enterprise Edition
echo ===============================================
echo.

REM Check if Node.js is installed
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo Please run setup.cmd first.
    pause
    exit /b 1
)

REM Run the start script
node start.js %*

pause