@echo off
REM Otedama Miner - Windows Launcher

echo ===================================
echo    Otedama Miner
echo    High-Performance Mining Software
echo ===================================
echo.

REM Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Error: Node.js is not installed.
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

REM Default configuration
set POOL_URL=stratum+tcp://localhost:3333
set POOL_USER=wallet.worker
set ALGORITHM=sha256

REM Check for user input
echo Current Configuration:
echo Pool: %POOL_URL%
echo User: %POOL_USER%
echo Algorithm: %ALGORITHM%
echo.

set /p custom="Use custom settings? (Y/N): "
if /i "%custom%" == "Y" (
    set /p POOL_URL="Enter pool URL: "
    set /p POOL_USER="Enter wallet address or username: "
    set /p ALGORITHM="Enter algorithm (sha256/ethash/scrypt/etc): "
)

echo.
echo Starting Otedama Miner...
echo.

REM Start miner
node otedama-miner.js -o %POOL_URL% -u %POOL_USER% -a %ALGORITHM%

pause