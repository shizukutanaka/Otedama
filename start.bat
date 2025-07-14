@echo off
echo.
echo ╔══════════════════════════════════════════════════════════════╗
echo ║                                                              ║
echo ║                    Otedama Commercial Pro                    ║
echo ║                      Version 6.0.0                          ║
echo ║                                                              ║
echo ║           Enterprise P2P Mining Pool + DeFi Platform        ║
echo ║                                                              ║
echo ╚══════════════════════════════════════════════════════════════╝
echo.

REM Check if Node.js is installed
echo [1/5] Checking Node.js installation...
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ ERROR: Node.js not found!
    echo.
    echo Please install Node.js 18+ from: https://nodejs.org
    echo After installation, restart this script.
    echo.
    pause
    exit /b 1
)

REM Check Node.js version
for /f "tokens=1 delims=v" %%i in ('node --version') do set NODE_VERSION=%%i
for /f "tokens=1 delims=." %%i in ("%NODE_VERSION:~1%") do set MAJOR_VERSION=%%i
if %MAJOR_VERSION% LSS 18 (
    echo ❌ ERROR: Node.js 18+ required. Current version: %NODE_VERSION%
    echo.
    echo Please update Node.js from: https://nodejs.org
    pause
    exit /b 1
)
echo ✅ Node.js %NODE_VERSION% detected

REM Check if dependencies are installed
echo [2/5] Checking dependencies...
if not exist "node_modules\" (
    echo 📦 Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo ❌ Failed to install dependencies
        pause
        exit /b 1
    )
    echo ✅ Dependencies installed
) else (
    echo ✅ Dependencies already installed
)

REM Create required directories
echo [3/5] Creating directories...
if not exist "data" mkdir data
if not exist "logs" mkdir logs
echo ✅ Directories created

REM Check configuration
echo [4/5] Checking configuration...
if not exist "otedama.json" (
    echo ⚠️  Configuration file not found, creating default...
    node index.js config >nul 2>&1
)

REM Check if wallet is configured
findstr /C:"walletAddress.*[a-zA-Z0-9]" otedama.json >nul
if errorlevel 1 (
    echo.
    echo ⚙️  FIRST-TIME SETUP REQUIRED
    echo.
    echo To start mining, you need to configure your wallet address.
    echo.
    set /p CONFIGURE_NOW="Would you like to configure it now? (y/n): "
    if /i "%CONFIGURE_NOW%"=="y" (
        echo.
        echo Supported currencies:
        echo   • BTC  - Bitcoin
        echo   • RVN  - Ravencoin  ^(recommended^)
        echo   • ETH  - Ethereum Classic
        echo   • XMR  - Monero
        echo   • LTC  - Litecoin
        echo   • DOGE - Dogecoin
        echo.
        set /p CURRENCY="Enter currency (default: RVN): "
        if "%CURRENCY%"=="" set CURRENCY=RVN
        echo.
        set /p WALLET="Enter your %CURRENCY% wallet address: "
        echo.
        echo Configuring wallet...
        node index.js --currency %CURRENCY% --wallet "%WALLET%"
        echo.
    )
) else (
    echo ✅ Wallet configured
)

REM Start Otedama
echo [5/5] Starting Otedama Commercial Pro...
echo.
echo 🚀 Launching with immutable operator fee system
echo 💰 BTC Address: bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh
echo 📊 Fee Rate: 0.1% (FIXED)
echo.
echo Press Ctrl+C to stop the service
echo.

REM Set window title
title Otedama Commercial Pro v6.0.0 - Mining Pool and DeFi Platform

REM Start the application
node index.js

REM If we reach here, the application has stopped
echo.
echo 🛑 Otedama has stopped
echo.
pause
