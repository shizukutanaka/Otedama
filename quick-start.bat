@echo off
REM Otedama Quick Start - One-click mining for beginners
REM This script automatically sets up and starts mining with minimal configuration

echo.
echo ====================================================
echo      Otedama Quick Start - Beginner Mining
echo ====================================================
echo.
echo This will automatically set up mining with the
echo following configuration:
echo.
echo   - Mode: Standalone (Solo mining)
echo   - Pool fee: 1%% (Industry lowest!)
echo   - Auto-switch to pool mode when others join
echo   - All other settings: Automatic
echo.
echo ====================================================
echo.

REM Check Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo.
    echo Installing Node.js is required. Would you like to:
    echo   1. Download Node.js installer (recommended)
    echo   2. Exit and install manually
    echo.
    choice /c 12 /n /m "Select option (1-2): "
    if %errorlevel% equ 1 (
        echo Opening Node.js download page...
        start https://nodejs.org/en/download/
        echo.
        echo Please install Node.js and run this script again.
    )
    pause
    exit /b 1
)

REM Install dependencies if needed
if not exist "node_modules" (
    echo Installing Otedama... This may take a few minutes.
    echo.
    call npm install --quiet
    if %errorlevel% neq 0 (
        echo [ERROR] Installation failed
        pause
        exit /b 1
    )
)

REM Check if wallet address exists
if not exist "config\wallet.txt" (
    echo.
    echo ====================================================
    echo        IMPORTANT: Bitcoin Address Required
    echo ====================================================
    echo.
    echo Please enter your Bitcoin address to receive mining rewards.
    echo.
    echo Supported formats:
    echo   - Legacy (1...): e.g., 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa
    echo   - SegWit (3...): e.g., 3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy
    echo   - Native SegWit (bc1...): e.g., bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh
    echo.
    set /p WALLET_ADDRESS="Your Bitcoin address: "
    
    REM Save wallet address
    if not exist "config" mkdir config
    echo %WALLET_ADDRESS%> config\wallet.txt
    echo.
    echo Wallet address saved!
) else (
    REM Read existing wallet address
    set /p WALLET_ADDRESS=<config\wallet.txt
    echo Using saved wallet address: %WALLET_ADDRESS%
)

echo.
echo Starting Otedama in beginner mode...
echo.

REM Create simple config if it doesn't exist
if not exist "config\otedama.json" (
    echo Creating configuration...
    if not exist "config" mkdir config
    (
        echo {
        echo   "mode": "standalone",
        echo   "experienceLevel": "beginner",
        echo   "pool": {
        echo     "port": 3333,
        echo     "fee": 1.0,
        echo     "minPayout": 0.001
        echo   },
        echo   "wallet": {
        echo     "address": "%WALLET_ADDRESS%"
        echo   },
        echo   "api": {
        echo     "port": 8080,
        echo     "enabled": true
        echo   }
        echo }
    ) > config\otedama.json
)

REM Start mining
echo.
echo ====================================================
echo           Mining Started Successfully!
echo ====================================================
echo.
echo   Dashboard: http://localhost:8080
echo   Pool Port: 3333
echo   Mode: Standalone (auto-scaling)
echo   
echo   Your wallet: %WALLET_ADDRESS%
echo.
echo   Press Ctrl+C to stop mining
echo ====================================================
echo.

REM Set creator fee address (optional, can be removed)
set CREATOR_WALLET_ADDRESS=1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa

REM Start Otedama
node index.js --config config\otedama.json --mode standalone --wallet %WALLET_ADDRESS%

pause