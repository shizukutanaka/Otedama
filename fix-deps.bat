@echo off
REM Otedama Go Module Dependency Fix Script for Windows
REM High-performance P2P mining pool and mining software

echo ================================================
echo Otedama Go Module Dependency Resolution
echo ================================================

REM Check if Go is available
echo Checking Go installation...
go version
if %errorlevel% neq 0 (
    echo ERROR: Go is not installed or not in PATH
    echo Please install Go from https://golang.org/dl/
    pause
    exit /b 1
)

echo Go installation detected successfully!

REM Create build directory if it doesn't exist
if not exist "build" mkdir build

REM Backup original go.mod
echo Backing up go.mod...
copy go.mod go.mod.backup

REM Clean Go cache
echo Cleaning Go cache...
go clean -modcache
go clean -cache
go clean -testcache

REM Fix dependencies
echo Fixing Go module dependencies...
go mod tidy -compat=1.23

REM Verify module integrity
echo Verifying module integrity...
go mod verify

REM Download missing dependencies
echo Downloading missing dependencies...
go mod download

REM Check for build issues
echo Checking for build issues...
go list -m all > build\module-list.txt

REM Test build
echo Testing build process...
go build -v ./... > build\build-log.txt 2>&1

if %errorlevel% neq 0 (
    echo WARNING: Build test failed, but dependencies are resolved
    echo Check build\build-log.txt for details
) else (
    echo Build test completed successfully!
)

REM Generate dependency report
echo Generating dependency report...
echo Otedama Dependency Report > build\dependency-report.txt
echo ========================= >> build\dependency-report.txt
echo. >> build\dependency-report.txt
echo Timestamp: %date% %time% >> build\dependency-report.txt
echo Go Version: >> build\dependency-report.txt
go version >> build\dependency-report.txt
echo. >> build\dependency-report.txt
echo Module Status: >> build\dependency-report.txt
go list -m all >> build\dependency-report.txt

echo ================================================
echo Dependency resolution completed!
echo ================================================
echo Next steps:
echo 1. Review build\dependency-report.txt
echo 2. Review build\build-log.txt
echo 3. Run 'go run cmd\otedama\main.go' to test
echo 4. Check Makefile for additional targets
pause
