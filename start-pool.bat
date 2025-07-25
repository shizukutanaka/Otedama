@echo off
REM Otedama Mining Pool - Quick Start Script for Windows

echo Starting Otedama Mining Pool...

REM Check if node is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: Node.js is not installed
    exit /b 1
)

REM Check if dependencies are installed
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
)

REM Check for .env file
if not exist ".env" (
    echo Creating .env file from example...
    copy .env.example .env
    echo Please edit .env file with your configuration
    exit /b 1
)

REM Check for config file
if not exist "otedama.config.js" (
    echo Creating config file from example...
    copy otedama.config.example.js otedama.config.js
)

REM Start the pool
echo Starting mining pool...
node start-mining-pool.js %*
