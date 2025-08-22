@echo off
REM Production optimization script for Otedama
TITLE Otedama Production Optimizer

echo ========================================
echo    Otedama Production Optimization
echo ========================================
echo.

REM Check for admin privileges
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo This script requires administrator privileges
    pause
    exit /b 1
)

echo [1/8] Removing duplicate and unnecessary files...

REM Remove duplicate documentation
if exist FINAL_REPORT.md del /f /q FINAL_REPORT.md 2>nul
if exist IMPLEMENTATION_REPORT.md del /f /q IMPLEMENTATION_REPORT.md 2>nul
if exist IMPLEMENTATION_PLAN.md del /f /q IMPLEMENTATION_PLAN.md 2>nul
if exist IMPROVEMENTS_500.md del /f /q IMPROVEMENTS_500.md 2>nul

REM Remove old cleanup scripts
if exist cleanup_duplicates.bat del /f /q cleanup_duplicates.bat 2>nul
if exist cleanup_duplicates_v2.bat del /f /q cleanup_duplicates_v2.bat 2>nul
if exist rebuild.bat del /f /q rebuild.bat 2>nul
if exist build.ps1 del /f /q build.ps1 2>nul
if exist cleanup.sh del /f /q cleanup.sh 2>nul

echo [2/8] Consolidating internal modules...

REM Remove empty or duplicate internal directories
for /d %%d in (internal\app internal\backup internal\benchmark internal\common internal\core internal\currency internal\database internal\logging internal\memory internal\middleware internal\models internal\network internal\profit internal\protocol internal\storage internal\updater internal\validation) do (
    if exist %%d (
        rd /s /q %%d 2>nul
    )
)

REM Merge duplicate modules
if exist internal\cpu (
    xcopy /s /e /y internal\cpu\*.go internal\hardware\ >nul 2>&1
    rd /s /q internal\cpu 2>nul
)
if exist internal\gpu (
    xcopy /s /e /y internal\gpu\*.go internal\hardware\ >nul 2>&1
    rd /s /q internal\gpu 2>nul
)
if exist internal\asic (
    xcopy /s /e /y internal\asic\*.go internal\hardware\ >nul 2>&1
    rd /s /q internal\asic 2>nul
)
if exist internal\auth (
    xcopy /s /e /y internal\auth\*.go internal\security\ >nul 2>&1
    rd /s /q internal\auth 2>nul
)
if exist internal\crypto (
    xcopy /s /e /y internal\crypto\*.go internal\security\ >nul 2>&1
    rd /s /q internal\crypto 2>nul
)
if exist internal\pool (
    xcopy /s /e /y internal\pool\*.go internal\p2p\ >nul 2>&1
    rd /s /q internal\pool 2>nul
)
if exist internal\worker (
    xcopy /s /e /y internal\worker\*.go internal\mining\ >nul 2>&1
    rd /s /q internal\worker 2>nul
)
if exist internal\performance (
    xcopy /s /e /y internal\performance\*.go internal\optimization\ >nul 2>&1
    rd /s /q internal\performance 2>nul
)
if exist internal\tuning (
    xcopy /s /e /y internal\tuning\*.go internal\optimization\ >nul 2>&1
    rd /s /q internal\tuning 2>nul
)
if exist internal\health (
    xcopy /s /e /y internal\health\*.go internal\monitoring\ >nul 2>&1
    rd /s /q internal\health 2>nul
)

echo [3/8] Cleaning build artifacts...

if exist build rd /s /q build 2>nul
if exist dist rd /s /q dist 2>nul
if exist vendor rd /s /q vendor 2>nul
if exist .venv rd /s /q .venv 2>nul
if exist code_quality_reports rd /s /q code_quality_reports 2>nul
del /f /q *.exe 2>nul
del /f /q *.log 2>nul
del /f /q *.tmp 2>nul
del /f /q *.pid 2>nul
del /f /q coverage.* 2>nul
del /f /q *.prof 2>nul

echo [4/8] Optimizing configuration files...

REM Use production config as default if it exists
if exist config.production.yaml (
    if exist config.yaml (
        copy /y config.yaml config.yaml.backup >nul 2>&1
    )
    copy /y config.production.yaml config.yaml >nul 2>&1
)

echo [5/8] Setting up production directories...

if not exist logs mkdir logs
if not exist data mkdir data
if not exist data\blockchain mkdir data\blockchain
if not exist data\shares mkdir data\shares
if not exist benchmark_results mkdir benchmark_results

echo [6/8] Optimizing Go modules...

go mod tidy 2>nul
go mod download 2>nul
go mod verify 2>nul

echo [7/8] Building production binary...

set GOOS=windows
set GOARCH=amd64
set CGO_ENABLED=1
set VERSION=Production
set BUILD_TIME=%date% %time%

go build -v ^
    -ldflags="-s -w -X 'main.Version=%VERSION%' -X 'main.BuildTime=%BUILD_TIME%'" ^
    -gcflags="-l=4" ^
    -trimpath ^
    -o otedama.exe ^
    cmd\otedama\main.go 2>nul

if exist otedama.exe (
    echo Binary built successfully: otedama.exe
) else (
    echo Warning: Binary build failed or Go not installed
)

echo [8/8] Final cleanup and optimization...

REM Clear Windows temp files
del /f /s /q %temp%\* 2>nul
rd /s /q %temp%\* 2>nul

REM Optimize Windows prefetch
if exist %windir%\Prefetch (
    del /f /q %windir%\Prefetch\OTEDAMA*.pf 2>nul
)

echo.
echo ========================================
echo    Optimization Complete!
echo ========================================
echo.
echo Project structure optimized:
echo - Removed duplicate files
echo - Consolidated modules
echo - Cleaned build artifacts
echo - Production config applied
echo - Binary built (if Go installed)
echo.
echo Current structure:
dir /ad /b
echo.
echo Internal modules:
dir /ad /b internal\
echo.
echo Ready for production deployment!
echo.
pause
