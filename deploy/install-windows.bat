@echo off
REM Otedama Windows Service Installation

echo ========================================
echo    Otedama Windows Service Installer
echo ========================================
echo.

REM Check for admin rights
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo This script requires administrator privileges.
    echo Please run as administrator.
    pause
    exit /b 1
)

REM Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js is not installed.
    echo Please install Node.js 18.0.0 or higher first.
    pause
    exit /b 1
)

REM Install directory
set INSTALL_DIR=C:\Otedama
echo Installation directory: %INSTALL_DIR%

REM Create directories
echo Creating directories...
mkdir "%INSTALL_DIR%" 2>nul
mkdir "%INSTALL_DIR%\data" 2>nul
mkdir "%INSTALL_DIR%\logs" 2>nul
mkdir "%INSTALL_DIR%\backups" 2>nul

REM Copy files
echo Copying files...
xcopy /E /Y /I *.* "%INSTALL_DIR%\" >nul
xcopy /E /Y /I examples "%INSTALL_DIR%\examples\" >nul
xcopy /E /Y /I deploy "%INSTALL_DIR%\deploy\" >nul

REM Install dependencies
echo Installing dependencies...
cd /d "%INSTALL_DIR%"
call npm install

if %errorlevel% neq 0 (
    echo Failed to install dependencies.
    pause
    exit /b 1
)

REM Configure
echo.
echo ========================================
echo           Configuration
echo ========================================
echo.

set /p WALLET="Enter your wallet address: "
set /p CURRENCY="Enter currency (RVN/BTC/XMR/LTC/DOGE): "
set /p POOL_NAME="Enter pool name [Otedama Pool]: "
if "%POOL_NAME%"=="" set POOL_NAME=Otedama Pool

REM Create configuration
node index.js --wallet "%WALLET%" --currency "%CURRENCY%"

REM Install Windows service using node-windows
echo.
echo Installing Windows service...

REM Create service installer script
(
echo const Service = require('node-windows'^).Service;
echo.
echo const svc = new Service({
echo   name: 'Otedama Mining Pool',
echo   description: 'Otedama P2P Mining Pool and DEX Platform',
echo   script: '%INSTALL_DIR%\\index.js',
echo   nodeOptions: ['--max-old-space-size=1024'],
echo   env: {
echo     name: 'NODE_ENV',
echo     value: 'production'
echo   }
echo }^);
echo.
echo svc.on('install', function(^){
echo   console.log('Service installed successfully'^);
echo   svc.start(^);
echo }^);
echo.
echo svc.on('start', function(^){
echo   console.log('Service started'^);
echo }^);
echo.
echo svc.on('error', function(err^){
echo   console.error('Service error:', err^);
echo }^);
echo.
echo svc.install(^);
) > "%INSTALL_DIR%\install-service.js"

REM Install node-windows
call npm install node-windows

REM Run service installer
node "%INSTALL_DIR%\install-service.js"

REM Configure Windows Firewall
echo.
echo Configuring Windows Firewall...
netsh advfirewall firewall add rule name="Otedama API" dir=in action=allow protocol=TCP localport=8080
netsh advfirewall firewall add rule name="Otedama Stratum" dir=in action=allow protocol=TCP localport=3333
netsh advfirewall firewall add rule name="Otedama P2P" dir=in action=allow protocol=TCP localport=8333

REM Create scheduled tasks
echo Creating scheduled tasks...

REM Monitor task
schtasks /create /tn "Otedama Monitor" /tr "node %INSTALL_DIR%\monitor.js" /sc minute /mo 5 /ru SYSTEM /f >nul

REM Backup task
schtasks /create /tn "Otedama Backup" /tr "node %INSTALL_DIR%\backup.js create" /sc daily /st 02:00 /ru SYSTEM /f >nul

REM Payment task
schtasks /create /tn "Otedama Payments" /tr "node %INSTALL_DIR%\payment.js" /sc hourly /ru SYSTEM /f >nul

REM Create shortcuts
echo Creating shortcuts...
powershell -Command "$WshShell = New-Object -comObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%USERPROFILE%\Desktop\Otedama Dashboard.lnk'); $Shortcut.TargetPath = 'http://localhost:8080'; $Shortcut.IconLocation = 'shell32.dll,14'; $Shortcut.Save()"

REM Display completion message
echo.
echo ========================================
echo      Installation Complete!
echo ========================================
echo.
echo Dashboard: http://localhost:8080
echo Stratum:  stratum+tcp://localhost:3333
echo.
echo Service Management:
echo   services.msc - Windows Services Manager
echo   sc query "Otedama Mining Pool" - Check status
echo   sc stop "Otedama Mining Pool" - Stop service
echo   sc start "Otedama Mining Pool" - Start service
echo.
echo Configuration: %INSTALL_DIR%\otedama.json
echo Logs: %INSTALL_DIR%\logs\
echo Data: %INSTALL_DIR%\data\
echo.
echo A shortcut to the dashboard has been created on your desktop.
echo.
pause
