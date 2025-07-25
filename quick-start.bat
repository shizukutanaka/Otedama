@echo off
REM Otedama Mining Pool - Quick Start Script for Windows

echo ======================================
echo     Otedama Mining Pool Quick Start   
echo ======================================
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: Node.js is not installed.
    echo Please install Node.js 18+ from https://nodejs.org/
    pause
    exit /b 1
)

REM Check Node.js version
for /f "tokens=1,2,3 delims=." %%a in ('node -v') do (
    set NODE_MAJOR=%%a
    set NODE_MAJOR=!NODE_MAJOR:v=!
)

REM Install dependencies if needed
if not exist "node_modules" (
    echo Installing dependencies...
    npm install
    if %errorlevel% neq 0 (
        echo Error: Failed to install dependencies
        pause
        exit /b 1
    )
)

REM Create required directories
if not exist "data" mkdir data
if not exist "logs" mkdir logs

REM Copy configuration files if they don't exist
if not exist ".env" (
    if exist ".env.example" (
        echo Creating .env from .env.example...
        copy .env.example .env >nul
        echo.
        echo IMPORTANT: Please edit .env and set your pool configuration:
        echo   - POOL_ADDRESS ^(your wallet address^)
        echo   - BITCOIN_RPC_PASSWORD ^(your Bitcoin node password^)
        echo.
        pause
    ) else (
        echo Error: .env.example not found
        pause
        exit /b 1
    )
)

if not exist "otedama.config.js" (
    if exist "otedama.config.example.js" (
        echo Creating otedama.config.js from example...
        copy otedama.config.example.js otedama.config.js >nul
    )
)

REM Validate configuration
echo Validating configuration...
npm run config:validate
if %errorlevel% neq 0 (
    echo Error: Configuration validation failed
    pause
    exit /b 1
)

REM Start the pool
echo.
echo Starting Otedama Mining Pool...
echo ======================================
echo.

REM Run with garbage collection exposed for better memory management
node --expose-gc start-mining-pool.js %*
