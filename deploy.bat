@echo off
REM Deployment script for Otedama - Windows Production
TITLE Otedama Production Deployment

echo ========================================
echo    Otedama - Production Deployment
echo ========================================
echo.

REM Check prerequisites
echo Checking prerequisites...

where go >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Go is not installed
    pause
    exit /b 1
)

where docker >nul 2>&1
if %errorlevel% neq 0 (
    echo WARNING: Docker is not installed (optional for containerized deployment)
)

echo Prerequisites check completed.
echo.

REM Run tests first
echo Running test suite...
call test.bat
if %errorlevel% neq 0 (
    echo ERROR: Tests failed. Aborting deployment.
    pause
    exit /b 1
)
echo.

REM Build production binary
echo Building production binary...
set GOOS=windows
set GOARCH=amd64
set CGO_ENABLED=1
set VERSION=Otedama-Production
set BUILD_TIME=%date% %time%
set GIT_COMMIT=release

go build -v ^
    -ldflags="-s -w -X 'main.Version=%VERSION%' -X 'main.BuildTime=%BUILD_TIME%' -X 'main.GitCommit=%GIT_COMMIT%'" ^
    -gcflags="-l=4" ^
    -trimpath ^
    -o build\bin\otedama.exe ^
    cmd\otedama\*.go

if %errorlevel% neq 0 (
    echo ERROR: Build failed
    pause
    exit /b 1
)
echo Production binary built successfully.
echo.

REM Create deployment directory
set DEPLOY_DIR=deploy
if not exist %DEPLOY_DIR% mkdir %DEPLOY_DIR%

echo Preparing deployment package...

REM Copy binary
copy build\bin\otedama.exe %DEPLOY_DIR%\ >nul

REM Copy configuration files
if exist config.yaml (
    copy config.yaml %DEPLOY_DIR%\config.yaml.backup >nul
)
copy config.yaml.example %DEPLOY_DIR%\config.yaml.example >nul

REM Copy scripts
copy start.bat %DEPLOY_DIR%\ >nul
copy stop.bat %DEPLOY_DIR%\ >nul 2>nul

REM Copy documentation
copy README.md %DEPLOY_DIR%\ >nul
copy LICENSE %DEPLOY_DIR%\ >nul

REM Create necessary directories
if not exist %DEPLOY_DIR%\data mkdir %DEPLOY_DIR%\data
if not exist %DEPLOY_DIR%\logs mkdir %DEPLOY_DIR%\logs
if not exist %DEPLOY_DIR%\web mkdir %DEPLOY_DIR%\web
xcopy web\* %DEPLOY_DIR%\web\ /E /Q >nul

echo Deployment package created in %DEPLOY_DIR%\
echo.

REM Optional: Build Docker image
where docker >nul 2>&1
if %errorlevel% equ 0 (
    echo Building Docker image...
    docker build -t otedama:latest -t otedama:production .
    if %errorlevel% equ 0 (
        echo Docker image built successfully.
        echo To run: docker run -d -p 8080:8080 -p 18555:18555 otedama:production
    ) else (
        echo WARNING: Docker build failed
    )
    echo.
)

REM Create Windows service installer (optional)
echo Creating Windows service installer...
(
echo @echo off
echo echo Installing Otedama as Windows Service...
echo sc create Otedama binPath= "%CD%\%DEPLOY_DIR%\otedama.exe -config %CD%\%DEPLOY_DIR%\config.yaml" start= auto
echo sc description Otedama "Otedama P2P Mining Software"
echo echo Service installed. Use 'sc start Otedama' to start.
echo pause
) > %DEPLOY_DIR%\install-service.bat

(
echo @echo off
echo echo Uninstalling Otedama Windows Service...
echo sc stop Otedama
echo sc delete Otedama
echo echo Service uninstalled.
echo pause
) > %DEPLOY_DIR%\uninstall-service.bat

echo.
echo ========================================
echo    Deployment Complete!
echo ========================================
echo.
echo Deployment package created in: %DEPLOY_DIR%\
echo.
echo Next steps:
echo 1. Copy the %DEPLOY_DIR% folder to your production server
echo 2. Edit config.yaml with your production settings
echo 3. Run start.bat to begin mining
echo.
echo For Windows Service:
echo - Run install-service.bat to install as service
echo - Use 'sc start Otedama' to start the service
echo.
echo For Docker:
echo - docker run -d -p 8080:8080 otedama:production
echo.

pause
