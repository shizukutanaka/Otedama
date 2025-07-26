@echo off
REM Otedama Setup Script for Windows
REM Automatically runs the Node.js setup script

echo ===============================================
echo  Otedama Mining Pool Setup - Windows
echo  Version 1.1.1 - Enterprise Edition
echo ===============================================
echo.

REM Check if Node.js is installed
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo.
    echo Please install Node.js 18.0.0 or higher from:
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
)

REM Check Node.js version
for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo [INFO] Found Node.js %NODE_VERSION%

REM Check if npm is installed
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] npm is not installed!
    echo Please reinstall Node.js with npm included.
    pause
    exit /b 1
)

REM Run the setup script
echo.
echo Starting Otedama setup...
echo.

node setup.js

echo.
echo ===============================================
echo  Setup process completed!
echo ===============================================
echo.

pause