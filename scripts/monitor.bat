@echo off
REM Simple health monitoring script for Windows

set API_URL=http://localhost:8080/api

:loop
cls
echo Otedama Light - Health Monitor
echo ==============================
echo Time: %date% %time%
echo.

REM Check API health
curl -s "%API_URL%/health" >nul 2>&1
if %errorlevel% equ 0 (
    echo API Status: [OK] HEALTHY
    
    REM Get pool stats
    echo.
    echo Pool Statistics:
    echo ---------------
    curl -s "%API_URL%/stats" 2>nul | findstr /C:"activeMiners" /C:"totalHashrate" /C:"totalShares" /C:"blocksFound"
) else (
    echo API Status: [ERROR] UNREACHABLE
)

REM Check Stratum port
echo.
powershell -Command "if((Test-NetConnection -ComputerName localhost -Port 3333).TcpTestSucceeded){'Stratum Port: [OK] OPEN'}else{'Stratum Port: [ERROR] CLOSED'}"

REM Check memory usage
echo.
echo System Resources:
echo ----------------
wmic OS get TotalVisibleMemorySize,FreePhysicalMemory /value | findstr /C:"="

REM Check data directory size
echo.
if exist "data" (
    echo Data Directory:
    dir data | findstr "File(s)"
)

echo.
echo Press Ctrl+C to exit
timeout /t 5 /nobreak >nul
goto loop
