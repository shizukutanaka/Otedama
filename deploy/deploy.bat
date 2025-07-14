@echo off
setlocal enabledelayedexpansion

REM Otedama Windows Deployment Script
REM Unified installation and update script

REM Colors (using ANSI escape codes - Windows 10+)
set "RED=[31m"
set "GREEN=[32m"
set "YELLOW=[33m"
set "BLUE=[34m"
set "NC=[0m"

REM Detect if updating or installing
set "MODE=install"
if exist "C:\Otedama\index.js" (
    set "MODE=update"
)

REM Header
echo.
echo %BLUE%========================================%NC%
echo %BLUE%     Otedama Deployment Script%NC%
echo %BLUE%     Mode: %MODE%%NC%
echo %BLUE%========================================%NC%
echo.

REM Check administrator privileges
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo %RED%This script requires administrator privileges%NC%
    echo Please run as administrator
    pause
    exit /b 1
)

REM Function: Install Node.js check
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo %RED%Node.js is not installed%NC%
    echo Please install Node.js 18.0.0 or higher from https://nodejs.org/
    echo Then run this script again
    pause
    exit /b 1
)

REM Check Node.js version
for /f "tokens=*" %%i in ('node -v') do set NODE_VERSION=%%i
echo %GREEN%√ Node.js version: %NODE_VERSION%%NC%

REM Set paths
set "OTEDAMA_PATH=C:\Otedama"
set "BACKUP_PATH=C:\Otedama-backup-%date:~-4%%date:~4,2%%date:~7,2%-%time:~0,2%%time:~3,2%%time:~6,2%"
set "BACKUP_PATH=%BACKUP_PATH: =0%"

if "%MODE%"=="install" goto :install
if "%MODE%"=="update" goto :update

:install
echo.
echo %YELLOW%Installing Otedama...%NC%
echo.

REM Create directory
echo Creating directory...
if not exist "%OTEDAMA_PATH%" (
    mkdir "%OTEDAMA_PATH%"
    mkdir "%OTEDAMA_PATH%\data"
    mkdir "%OTEDAMA_PATH%\logs"
    mkdir "%OTEDAMA_PATH%\backups"
)

REM Copy files
echo Copying files...
xcopy /E /Y /Q . "%OTEDAMA_PATH%\" >nul
echo %GREEN%√ Files copied%NC%

REM Install dependencies
echo Installing dependencies...
cd /d "%OTEDAMA_PATH%"
call npm install
if %errorlevel% neq 0 (
    echo %RED%Failed to install dependencies%NC%
    pause
    exit /b 1
)
echo %GREEN%√ Dependencies installed%NC%

REM Configure
if not exist "%OTEDAMA_PATH%\otedama.json" (
    echo.
    echo %BLUE%======== Configuration ========%NC%
    echo.
    
    set /p WALLET="Enter your wallet address: "
    set /p CURRENCY="Enter currency (RVN/BTC/XMR/LTC/DOGE): "
    set /p POOL_NAME="Enter pool name [Otedama Pool]: "
    
    if "!POOL_NAME!"=="" set "POOL_NAME=Otedama Pool"
    
    node index.js --wallet "!WALLET!" --currency "!CURRENCY!"
    echo %GREEN%√ Configuration saved%NC%
)

REM Create service
echo.
echo %YELLOW%Creating Windows service...%NC%

REM Create service wrapper script
echo @echo off > "%OTEDAMA_PATH%\otedama-service.bat"
echo cd /d "%OTEDAMA_PATH%" >> "%OTEDAMA_PATH%\otedama-service.bat"
echo node index.js >> "%OTEDAMA_PATH%\otedama-service.bat"

REM Install NSSM if not present
if not exist "%OTEDAMA_PATH%\nssm.exe" (
    echo Downloading NSSM...
    powershell -Command "Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile '%TEMP%\nssm.zip'"
    powershell -Command "Expand-Archive -Path '%TEMP%\nssm.zip' -DestinationPath '%TEMP%\nssm' -Force"
    copy "%TEMP%\nssm\nssm-2.24\win64\nssm.exe" "%OTEDAMA_PATH%\"
    del "%TEMP%\nssm.zip"
    rmdir /S /Q "%TEMP%\nssm"
)

REM Create service using NSSM
"%OTEDAMA_PATH%\nssm.exe" install Otedama "%OTEDAMA_PATH%\otedama-service.bat"
"%OTEDAMA_PATH%\nssm.exe" set Otedama AppDirectory "%OTEDAMA_PATH%"
"%OTEDAMA_PATH%\nssm.exe" set Otedama DisplayName "Otedama Mining Pool"
"%OTEDAMA_PATH%\nssm.exe" set Otedama Description "Commercial Grade P2P Mining Pool & DEX"
"%OTEDAMA_PATH%\nssm.exe" set Otedama Start SERVICE_AUTO_START

echo %GREEN%√ Service created%NC%

REM Configure firewall
echo.
echo %YELLOW%Configuring Windows Firewall...%NC%
netsh advfirewall firewall add rule name="Otedama API" dir=in action=allow protocol=TCP localport=8080 >nul 2>&1
netsh advfirewall firewall add rule name="Otedama Stratum" dir=in action=allow protocol=TCP localport=3333 >nul 2>&1
netsh advfirewall firewall add rule name="Otedama P2P" dir=in action=allow protocol=TCP localport=8333 >nul 2>&1
echo %GREEN%√ Firewall configured%NC%

REM Create scheduled tasks
echo.
echo %YELLOW%Creating scheduled tasks...%NC%

REM Monitor task
schtasks /create /tn "Otedama Monitor" /tr "\"%OTEDAMA_PATH%\node.exe\" \"%OTEDAMA_PATH%\monitor.js\"" /sc minute /mo 5 /f >nul 2>&1

REM Backup task
schtasks /create /tn "Otedama Backup" /tr "\"%OTEDAMA_PATH%\node.exe\" \"%OTEDAMA_PATH%\backup.js\" create" /sc daily /st 02:00 /f >nul 2>&1

REM Payment task
schtasks /create /tn "Otedama Payments" /tr "\"%OTEDAMA_PATH%\node.exe\" \"%OTEDAMA_PATH%\payment.js\"" /sc hourly /f >nul 2>&1

echo %GREEN%√ Scheduled tasks created%NC%

REM Start service
echo.
echo %YELLOW%Starting Otedama service...%NC%
net start Otedama >nul 2>&1
echo %GREEN%√ Service started%NC%

goto :complete

:update
echo.
echo %YELLOW%Updating Otedama...%NC%
echo.

REM Stop service
echo Stopping service...
net stop Otedama >nul 2>&1
echo %GREEN%√ Service stopped%NC%

REM Create backup
echo Creating backup...
xcopy /E /I /Q "%OTEDAMA_PATH%" "%BACKUP_PATH%" >nul
echo %GREEN%√ Backup created at %BACKUP_PATH%%NC%

REM Update files
echo Updating files...
for %%f in (index.js monitor.js payment.js gpu.js backup.js package.json README.md) do (
    if exist "%%f" copy /Y "%%f" "%OTEDAMA_PATH%\" >nul
)

REM Update directories
for %%d in (web examples docs monitoring) do (
    if exist "%%d" xcopy /E /Y /Q "%%d" "%OTEDAMA_PATH%\%%d\" >nul
)

REM Update dependencies
echo Updating dependencies...
cd /d "%OTEDAMA_PATH%"
call npm install --production
echo %GREEN%√ Dependencies updated%NC%

REM Start service
echo Starting service...
net start Otedama >nul 2>&1
echo %GREEN%√ Service started%NC%

:complete
REM Get IP address
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do (
        set "IP=%%b"
        goto :gotip
    )
)
:gotip

echo.
echo %BLUE%========================================%NC%
echo %GREEN%%MODE% Complete!%NC%
echo %BLUE%========================================%NC%
echo.
echo Dashboard: http://%IP%:8080
echo           http://localhost:8080
echo Stratum:  stratum+tcp://%IP%:3333
echo.
echo Commands:
echo   net start Otedama      - Start service
echo   net stop Otedama       - Stop service
echo   sc query Otedama       - Check status
echo.
echo Management:
echo   node "%OTEDAMA_PATH%\monitor.js"    - Run monitor
echo   node "%OTEDAMA_PATH%\payment.js"    - Process payments
echo   node "%OTEDAMA_PATH%\backup.js"     - Manage backups
echo.
echo Files:
echo   Config: %OTEDAMA_PATH%\otedama.json
echo   Logs:   %OTEDAMA_PATH%\logs\
echo   Data:   %OTEDAMA_PATH%\data\

if "%MODE%"=="update" (
    echo   Backup: %BACKUP_PATH%
)

echo.
pause
