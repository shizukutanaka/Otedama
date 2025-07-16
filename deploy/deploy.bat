@echo off
REM Otedama Windows Deployment Script - Optimized for Production
REM Supports Windows 10/11 and Windows Server

setlocal enabledelayedexpansion

echo.
echo 🚀 Otedama Windows Production Deployment
echo ========================================

REM Configuration
set OTEDAMA_VERSION=0.6.0
set NODE_MIN_VERSION=18.0.0
set INSTALL_DIR=%PROGRAMFILES%\Otedama
set SERVICE_NAME=Otedama
set WEB_PORT=8080
set STRATUM_PORT=3333

REM Check if running as administrator
net session >nul 2>&1
if %errorLevel% == 0 (
    echo [INFO] Running as Administrator. Installing system-wide.
    set INSTALL_DIR=%PROGRAMFILES%\Otedama
) else (
    echo [INFO] Running as User. Installing to user directory.
    set INSTALL_DIR=%USERPROFILE%\Otedama
)

echo [INFO] Installation directory: %INSTALL_DIR%

REM Check requirements
echo [INFO] Checking system requirements...

REM Check Node.js
where node >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] Node.js is not installed
    echo [INFO] Please install Node.js from https://nodejs.org/
    echo [INFO] Download the LTS version for Windows
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
set NODE_VERSION=!NODE_VERSION:v=!
echo [SUCCESS] Node.js version !NODE_VERSION! found

REM Simple version check (not perfect but works for basic cases)
for /f "tokens=1,2,3 delims=." %%a in ("!NODE_VERSION!") do (
    set NODE_MAJOR=%%a
    set NODE_MINOR=%%b
)
if !NODE_MAJOR! lss 18 (
    echo [ERROR] Node.js version 18.0.0 or higher is required
    echo [INFO] Current version: !NODE_VERSION!
    pause
    exit /b 1
)

REM Check npm
where npm >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] npm is not installed
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('npm --version') do set NPM_VERSION=%%i
echo [SUCCESS] npm version !NPM_VERSION! found

REM Check if ports are in use
echo [INFO] Checking if ports are available...
netstat -an | findstr ":!WEB_PORT! " >nul 2>&1
if %errorLevel% == 0 (
    echo [WARNING] Port !WEB_PORT! is already in use
)

netstat -an | findstr ":!STRATUM_PORT! " >nul 2>&1
if %errorLevel% == 0 (
    echo [WARNING] Port !STRATUM_PORT! is already in use
)

REM Create installation directory
echo [INFO] Creating installation directory...
if not exist "!INSTALL_DIR!" (
    mkdir "!INSTALL_DIR!"
    if %errorLevel% neq 0 (
        echo [ERROR] Failed to create installation directory
        echo [INFO] Try running as Administrator or choose a different location
        pause
        exit /b 1
    )
)

REM Install Otedama
echo [INFO] Installing Otedama to !INSTALL_DIR!...
cd /d "!INSTALL_DIR!"

REM Copy or download files
if exist "%~dp0..\index.js" (
    echo [INFO] Copying local files...
    copy "%~dp0..\index.js" . >nul
    copy "%~dp0..\package.json" . >nul
    copy "%~dp0..\README.md" . >nul
    copy "%~dp0..\LICENSE" . >nul
    if exist "%~dp0..\otedama.json" (
        copy "%~dp0..\otedama.json" . >nul
    )
    
    if exist "%~dp0..\web" (
        xcopy "%~dp0..\web" "web" /E /I /Q >nul
    )
    if exist "%~dp0..\mobile" (
        xcopy "%~dp0..\mobile" "mobile" /E /I /Q >nul
    )
    if exist "%~dp0..\test" (
        xcopy "%~dp0..\test" "test" /E /I /Q >nul
    )
) else (
    echo [INFO] Downloading from repository...
    where curl >nul 2>&1
    if %errorLevel% == 0 (
        curl -L -o otedama.zip https://github.com/otedama/otedama/archive/main.zip
        if %errorLevel% == 0 (
            powershell -command "Expand-Archive -Path 'otedama.zip' -DestinationPath '.' -Force"
            move otedama-main\* . >nul 2>&1
            rmdir /s /q otedama-main >nul 2>&1
            del otedama.zip >nul 2>&1
        ) else (
            echo [ERROR] Failed to download Otedama
            pause
            exit /b 1
        )
    ) else (
        echo [ERROR] curl is not available for downloading
        echo [INFO] Please download manually from https://github.com/otedama/otedama
        pause
        exit /b 1
    )
)

REM Install dependencies
echo [INFO] Installing dependencies...
npm install --production --no-audit --no-fund
if %errorLevel% neq 0 (
    echo [ERROR] Failed to install dependencies
    pause
    exit /b 1
)

echo [SUCCESS] Otedama installed successfully

REM Create default configuration
echo [INFO] Creating default configuration...
if not exist "otedama.json" (
    (
        echo {
        echo   "pool": {
        echo     "name": "Otedama Windows Pool",
        echo     "fee": 1.5,
        echo     "minPayout": {
        echo       "BTC": 0.001,
        echo       "ETH": 0.01,
        echo       "RVN": 100,
        echo       "XMR": 0.1,
        echo       "LTC": 0.1
        echo     },
        echo     "payoutInterval": 3600000
        echo   },
        echo   "mining": {
        echo     "enabled": true,
        echo     "currency": "RVN",
        echo     "algorithm": "kawpow",
        echo     "walletAddress": "",
        echo     "threads": 0,
        echo     "intensity": 100
        echo   },
        echo   "network": {
        echo     "p2pPort": 8333,
        echo     "stratumPort": !STRATUM_PORT!,
        echo     "apiPort": !WEB_PORT!,
        echo     "maxPeers": 100,
        echo     "maxMiners": 10000
        echo   },
        echo   "dex": {
        echo     "enabled": true,
        echo     "tradingFee": 0.003,
        echo     "minLiquidity": 0.001,
        echo     "maxSlippage": 0.05
        echo   },
        echo   "security": {
        echo     "enableRateLimit": true,
        echo     "maxRequestsPerMinute": 1000,
        echo     "enableDDoSProtection": true,
        echo     "maxConnectionsPerIP": 10
        echo   },
        echo   "monitoring": {
        echo     "enableMetrics": true,
        echo     "enableAlerts": true,
        echo     "retention": 604800000
        echo   }
        echo }
    ) > otedama.json
    echo [SUCCESS] Default configuration created
) else (
    echo [INFO] Configuration file already exists
)

REM Create logs directory
if not exist "logs" (
    mkdir "logs"
)

REM Create Windows service (if running as admin)
net session >nul 2>&1
if %errorLevel% == 0 (
    echo [INFO] Creating Windows service...
    
    REM Create service wrapper script
    (
        echo @echo off
        echo cd /d "!INSTALL_DIR!"
        echo node index.js
    ) > otedama-service.bat
    
    REM Use nssm if available, otherwise use sc
    where nssm >nul 2>&1
    if %errorLevel% == 0 (
        echo [INFO] Using NSSM to create service...
        nssm install "!SERVICE_NAME!" "!INSTALL_DIR!\otedama-service.bat"
        nssm set "!SERVICE_NAME!" DisplayName "Otedama Mining Pool & DEX"
        nssm set "!SERVICE_NAME!" Description "Professional P2P Mining Pool with integrated DEX"
        nssm set "!SERVICE_NAME!" Start SERVICE_AUTO_START
        nssm set "!SERVICE_NAME!" AppStdout "!INSTALL_DIR!\logs\service.log"
        nssm set "!SERVICE_NAME!" AppStderr "!INSTALL_DIR!\logs\service-error.log"
        echo [SUCCESS] Windows service created with NSSM
    ) else (
        echo [INFO] Using built-in sc command...
        sc create "!SERVICE_NAME!" binpath= "cmd /c \"!INSTALL_DIR!\otedama-service.bat\"" start= auto DisplayName= "Otedama Mining Pool"
        if %errorLevel% == 0 (
            echo [SUCCESS] Windows service created
        ) else (
            echo [WARNING] Failed to create Windows service
        )
    )
) else (
    echo [INFO] Not running as Administrator. Service not created.
    echo [INFO] Run as Administrator to install as Windows service.
)

REM Configure Windows Firewall
net session >nul 2>&1
if %errorLevel% == 0 (
    echo [INFO] Configuring Windows Firewall...
    netsh advfirewall firewall add rule name="Otedama Web Interface" dir=in action=allow protocol=TCP localport=!WEB_PORT! >nul 2>&1
    netsh advfirewall firewall add rule name="Otedama Stratum Server" dir=in action=allow protocol=TCP localport=!STRATUM_PORT! >nul 2>&1
    echo [SUCCESS] Firewall rules added
) else (
    echo [WARNING] Cannot configure firewall. Run as Administrator to configure.
    echo [INFO] Manually allow ports !WEB_PORT! and !STRATUM_PORT! in Windows Firewall
)

REM Create desktop shortcut
echo [INFO] Creating desktop shortcut...
set DESKTOP=%USERPROFILE%\Desktop
(
    echo @echo off
    echo start "" "http://localhost:!WEB_PORT!"
) > "%DESKTOP%\Otedama Dashboard.bat"

REM Create start/stop scripts
(
    echo @echo off
    echo echo Starting Otedama...
    echo cd /d "!INSTALL_DIR!"
    echo start "Otedama" node index.js
    echo echo Otedama started. Dashboard: http://localhost:!WEB_PORT!
    echo pause
) > "!INSTALL_DIR!\start-otedama.bat"

(
    echo @echo off
    echo echo Stopping Otedama...
    echo taskkill /f /im node.exe /fi "WINDOWTITLE eq Otedama*" >nul 2>&1
    echo echo Otedama stopped.
    echo pause
) > "!INSTALL_DIR!\stop-otedama.bat"

REM Run basic tests
echo [INFO] Running system tests...
timeout /t 3 >nul
node test\otedama-test.js
if %errorLevel% neq 0 (
    echo [WARNING] Some tests failed, but installation can continue
)

REM Start Otedama
echo [INFO] Starting Otedama...
net session >nul 2>&1
if %errorLevel% == 0 (
    REM Try to start as service
    sc query "!SERVICE_NAME!" >nul 2>&1
    if %errorLevel% == 0 (
        net start "!SERVICE_NAME!" >nul 2>&1
        if %errorLevel! == 0 (
            echo [SUCCESS] Service started
        ) else (
            echo [INFO] Starting manually...
            start "Otedama" node index.js
        )
    ) else (
        echo [INFO] Starting manually...
        start "Otedama" node index.js
    )
) else (
    echo [INFO] Starting manually...
    start "Otedama" node index.js
)

REM Wait for startup
echo [INFO] Waiting for Otedama to start...
timeout /t 10 >nul

REM Test endpoints
where curl >nul 2>&1
if %errorLevel% == 0 (
    echo [INFO] Testing API endpoints...
    curl -s -f "http://localhost:!WEB_PORT!/api/health" >nul 2>&1
    if %errorLevel% == 0 (
        echo [SUCCESS] Health check passed
    ) else (
        echo [WARNING] Health check failed - may need more time to start
    )
)

REM Print completion message
echo.
echo [SUCCESS] Otedama deployment completed!
echo.
echo 🎉 Installation Summary:
echo ========================
echo • Installation Directory: !INSTALL_DIR!
echo • Web Dashboard: http://localhost:!WEB_PORT!
echo • Stratum Server: stratum+tcp://localhost:!STRATUM_PORT!
echo • Configuration: !INSTALL_DIR!\otedama.json
echo • Logs: !INSTALL_DIR!\logs\
echo.
echo 📝 Next Steps:
echo • Edit !INSTALL_DIR!\otedama.json to configure your wallet
echo • Visit http://localhost:!WEB_PORT! to monitor mining
echo • Desktop shortcut created: Otedama Dashboard.bat
echo.
echo 🛠️  Management:
net session >nul 2>&1
if %errorLevel% == 0 (
    echo • Start Service: net start "!SERVICE_NAME!"
    echo • Stop Service: net stop "!SERVICE_NAME!"
    echo • Service Status: sc query "!SERVICE_NAME!"
) else (
    echo • Start: !INSTALL_DIR!\start-otedama.bat
    echo • Stop: !INSTALL_DIR!\stop-otedama.bat
)
echo.
echo 💰 Start mining with 1.5%% fee - the industry's lowest!
echo 🌍 Supports 50+ languages and mobile PWA
echo 📱 Add to home screen: http://localhost:!WEB_PORT!
echo.
echo Press any key to open the dashboard...
pause >nul
start "" "http://localhost:!WEB_PORT!"

endlocal
