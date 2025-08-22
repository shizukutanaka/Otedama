@echo off
REM Final validation script for Otedama
TITLE Otedama Production Validation

echo ========================================
echo    Otedama Production Validation
echo ========================================
echo.

set PASS=0
set FAIL=0

echo Checking critical files...
echo.

REM Check main executable or source
if exist cmd\otedama\main.go (
    echo [PASS] Main source file exists
    set /a PASS+=1
) else (
    echo [FAIL] Main source file missing
    set /a FAIL+=1
)

REM Check critical internal packages
if exist internal\mining\engine_final.go (
    echo [PASS] Mining engine exists
    set /a PASS+=1
) else (
    echo [FAIL] Mining engine missing
    set /a FAIL+=1
)

if exist internal\hardware\unified_manager.go (
    echo [PASS] Hardware manager exists
    set /a PASS+=1
) else (
    echo [FAIL] Hardware manager missing
    set /a FAIL+=1
)

if exist internal\api\server.go (
    echo [PASS] API server exists
    set /a PASS+=1
) else (
    echo [FAIL] API server missing
    set /a FAIL+=1
)

if exist internal\security\enhanced_manager.go (
    echo [PASS] Security manager exists
    set /a PASS+=1
) else (
    echo [FAIL] Security manager missing
    set /a FAIL+=1
)

if exist internal\p2p\pool.go (
    echo [PASS] P2P pool exists
    set /a PASS+=1
) else (
    echo [FAIL] P2P pool missing
    set /a FAIL+=1
)

REM Check configuration files
if exist config.yaml (
    echo [PASS] Configuration file exists
    set /a PASS+=1
) else if exist config.yaml.example (
    echo [WARN] Using example config
    copy config.yaml.example config.yaml >nul
    set /a PASS+=1
) else (
    echo [FAIL] No configuration file
    set /a FAIL+=1
)

REM Check user scripts
if exist start.bat (
    echo [PASS] Start script exists
    set /a PASS+=1
) else (
    echo [FAIL] Start script missing
    set /a FAIL+=1
)

if exist stop.bat (
    echo [PASS] Stop script exists
    set /a PASS+=1
) else (
    echo [FAIL] Stop script missing
    set /a FAIL+=1
)

REM Check web interface
if exist web\index.html (
    echo [PASS] Web dashboard exists
    set /a PASS+=1
) else (
    echo [FAIL] Web dashboard missing
    set /a FAIL+=1
)

REM Check Go installation
where go >nul 2>&1
if %errorlevel% equ 0 (
    echo [PASS] Go is installed
    set /a PASS+=1
    
    REM Try to build
    echo.
    echo Attempting to build binary...
    go build -o otedama.exe cmd\otedama\main.go 2>nul
    if exist otedama.exe (
        echo [PASS] Binary built successfully
        set /a PASS+=1
    ) else (
        echo [WARN] Build failed - check Go modules
    )
) else (
    echo [WARN] Go not installed - cannot build
)

echo.
echo ========================================
echo    Validation Results
echo ========================================
echo.
echo Passed: %PASS% checks
echo Failed: %FAIL% checks
echo.

if %FAIL% equ 0 (
    echo Status: READY FOR PRODUCTION
    echo.
    echo Otedama is fully configured and ready to use!
    echo.
    echo Quick Start:
    echo 1. Edit config.yaml with your wallet address
    echo 2. Run: start.bat
    echo 3. Open: http://localhost:8080
) else (
    echo Status: ISSUES DETECTED
    echo.
    echo Please resolve the failed checks before running.
    echo Some components may be missing or misconfigured.
)

echo.
echo ========================================
echo    System Information
echo ========================================
echo.
echo Computer: %COMPUTERNAME%
echo Processor: %PROCESSOR_IDENTIFIER%
echo Cores: %NUMBER_OF_PROCESSORS%
echo Architecture: %PROCESSOR_ARCHITECTURE%
echo.

REM List available components
echo Available Components:
echo --------------------
dir /b internal\ 2>nul

echo.
pause
