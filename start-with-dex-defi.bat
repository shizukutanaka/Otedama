@echo off
echo Starting Otedama with DEX and DeFi features...
echo.

REM Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Error: Node.js is not installed. Please install Node.js first.
    echo Download from: https://nodejs.org/
    pause
    exit /b 1
)

REM Check if dependencies are installed
if not exist "node_modules" (
    echo Installing dependencies...
    npm install
    if %errorlevel% neq 0 (
        echo Error: Failed to install dependencies
        pause
        exit /b 1
    )
)

REM Start Otedama with all features
echo Starting Otedama...
echo.
echo Features enabled:
echo - P2P Mining Pool
echo - Decentralized Exchange (DEX)
echo - DeFi (Yield Farming, Lending, Staking)
echo.
echo Access the web interface at: http://localhost:8080
echo API endpoints available at: http://localhost:8080/api/v1
echo.
echo Press Ctrl+C to stop
echo.

node index.js --standalone --enable-dex --enable-defi --coinbase-address YOUR_WALLET_ADDRESS

pause