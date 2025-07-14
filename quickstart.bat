@echo off
REM Otedama Quick Start Script for Windows

echo =========================================
echo        Otedama Quick Start
echo =========================================
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: Node.js is not installed
    echo Please install Node.js 18.0.0 or higher
    pause
    exit /b 1
)

REM Get Node.js version
for /f "tokens=*" %%i in ('node -v') do set NODE_VERSION=%%i
echo √ Node.js version: %NODE_VERSION%

REM Check if npm is installed
where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: npm is not installed
    pause
    exit /b 1
)

REM Install dependencies
echo.
echo Installing dependencies...
call npm install

if %errorlevel% neq 0 (
    echo Error: Failed to install dependencies
    pause
    exit /b 1
)

echo √ Dependencies installed

REM Check if configuration exists
if not exist "otedama.json" (
    echo.
    echo No configuration found. Creating default configuration...
    
    REM Ask for currency
    echo.
    echo Select mining currency:
    echo 1) RVN (Ravencoin)
    echo 2) BTC (Bitcoin)
    echo 3) XMR (Monero)
    echo 4) LTC (Litecoin)
    echo 5) DOGE (Dogecoin)
    set /p CURRENCY_CHOICE="Enter choice (1-5): "
    
    if "%CURRENCY_CHOICE%"=="1" (
        set CURRENCY=RVN
        set ALGO=kawpow
    ) else if "%CURRENCY_CHOICE%"=="2" (
        set CURRENCY=BTC
        set ALGO=sha256
    ) else if "%CURRENCY_CHOICE%"=="3" (
        set CURRENCY=XMR
        set ALGO=randomx
    ) else if "%CURRENCY_CHOICE%"=="4" (
        set CURRENCY=LTC
        set ALGO=scrypt
    ) else if "%CURRENCY_CHOICE%"=="5" (
        set CURRENCY=DOGE
        set ALGO=scrypt
    ) else (
        set CURRENCY=RVN
        set ALGO=kawpow
    )
    
    REM Ask for wallet address
    echo.
    set /p WALLET="Enter your %CURRENCY% wallet address: "
    
    if "%WALLET%"=="" (
        echo Error: Wallet address is required
        pause
        exit /b 1
    )
    
    REM Create configuration
    node index.js --wallet "%WALLET%" --currency "%CURRENCY%" --algorithm "%ALGO%"
    
    echo √ Configuration created
)

REM Display current configuration
echo.
echo Current configuration:
node index.js config

REM Ask to start
echo.
set /p START_NOW="Start Otedama now? (y/n): "

if /i "%START_NOW%"=="y" (
    echo.
    echo Starting Otedama...
    echo Dashboard: http://localhost:8080
    echo Press Ctrl+C to stop
    echo.
    npm start
) else (
    echo.
    echo To start Otedama later, run:
    echo   npm start
    echo.
    echo Or with custom options:
    echo   node index.js --wallet YOUR_WALLET --currency RVN
    echo.
    pause
)
