@echo off

REM Otedama Minimal Setup
echo ⚡ Otedama Setup - Single File Edition
echo.

REM Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ Node.js not found. Install Node.js 16+ from https://nodejs.org/
    pause
    exit /b 1
)

for /f "tokens=1 delims=v" %%i in ('node -v') do set NODE_VERSION=%%i
for /f "tokens=1 delims=." %%i in ("%NODE_VERSION:v=%") do set MAJOR_VERSION=%%i
if %MAJOR_VERSION% lss 16 (
    echo ❌ Node.js version too old. Requires 16+
    pause
    exit /b 1
)

echo ✅ Node.js !NODE_VERSION!

REM Install dependencies
echo 📦 Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo ❌ Failed to install dependencies
    pause
    exit /b 1
)

REM Create directories
if not exist "data" mkdir data

echo.
echo 🎉 Setup complete!
echo.
echo Quick start:
echo   npm start                    # Start mining pool
echo   npm run config               # Show config  
echo   npm test                     # Run test
echo.
echo Dashboard: http://localhost:8080
echo Stratum:   stratum+tcp://localhost:3333
echo.
echo ⚙️ Edit config.json to set your wallet address
echo.
pause
