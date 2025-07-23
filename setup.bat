@echo off
echo.
echo ============================================
echo     Otedama Setup Wizard - Windows
echo ============================================
echo.

REM Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo.
    echo Please install Node.js from: https://nodejs.org/
    echo Recommended: LTS version
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js is installed
echo.

REM Check if npm modules are installed
if not exist "node_modules" (
    echo Installing dependencies...
    echo This may take a few minutes on first run.
    echo.
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo [ERROR] Failed to install dependencies
        pause
        exit /b 1
    )
)

echo.
echo Starting Otedama Setup Wizard...
echo.

REM Run the setup wizard
node index.js --setup

echo.
echo ============================================
echo Setup complete! 
echo.
echo To start mining, run: start-otedama.bat
echo ============================================
echo.
pause