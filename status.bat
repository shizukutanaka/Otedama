@echo off
REM Status monitoring script for Otedama
TITLE Otedama Status Monitor

:loop
cls
echo ========================================
echo    Otedama - Live Status Monitor
echo ========================================
echo.
echo Time: %date% %time%
echo.

REM Check if Otedama is running
tasklist | findstr /i "otedama.exe" >nul 2>&1
if %errorlevel% equ 0 (
    echo Status: MINING ACTIVE
    echo.
    
    REM Get process info
    echo Process Information:
    echo -------------------
    for /f "tokens=1-5" %%a in ('tasklist /fi "imagename eq otedama.exe" /fo list ^| findstr "PID Memory"') do (
        echo %%a %%b %%c %%d %%e
    )
) else (
    echo Status: NOT RUNNING
    echo.
    echo Otedama is not currently running.
    echo Run start.bat to begin mining.
)

echo.
echo Network Connections:
echo -------------------

REM Check API port
netstat -an | findstr ":8080" >nul 2>&1
if %errorlevel% equ 0 (
    echo API Server: LISTENING on port 8080
) else (
    echo API Server: NOT ACTIVE
)

REM Check metrics port
netstat -an | findstr ":9090" >nul 2>&1
if %errorlevel% equ 0 (
    echo Metrics: AVAILABLE on port 9090
) else (
    echo Metrics: NOT ACTIVE
)

REM Check P2P port
netstat -an | findstr ":18555" >nul 2>&1
if %errorlevel% equ 0 (
    echo P2P Network: CONNECTED on port 18555
    
    REM Count P2P connections
    for /f %%a in ('netstat -an ^| findstr ":18555" ^| findstr "ESTABLISHED" ^| find /c /v ""') do (
        echo P2P Peers: %%a connected
    )
) else (
    echo P2P Network: NOT ACTIVE
)

echo.
echo API Endpoints:
echo -------------
echo Dashboard: http://localhost:8080
echo API Status: http://localhost:8080/api/v1/status
echo Metrics: http://localhost:9090/metrics
echo Health: http://localhost:8081/health

REM Try to get stats from API
echo.
echo Mining Statistics:
echo -----------------

REM Check if curl is available
where curl >nul 2>&1
if %errorlevel% equ 0 (
    REM Get stats from API
    curl -s http://localhost:8080/api/v1/mining/stats 2>nul | findstr "hashrate shares temperature" 2>nul
    if %errorlevel% neq 0 (
        echo Unable to retrieve statistics
    )
) else (
    REM Try PowerShell as fallback
    powershell -Command "try { (Invoke-WebRequest -Uri 'http://localhost:8080/api/v1/mining/stats' -UseBasicParsing).Content } catch { 'API not accessible' }" 2>nul
)

echo.
echo System Resources:
echo ----------------
echo CPU Usage:
wmic cpu get loadpercentage /value | findstr "LoadPercentage"

echo Memory Usage:
for /f "tokens=2 delims==" %%a in ('wmic OS get TotalVisibleMemorySize /value ^| findstr "="') do set /a total=%%a/1024
for /f "tokens=2 delims==" %%a in ('wmic OS get FreePhysicalMemory /value ^| findstr "="') do set /a free=%%a/1024
set /a used=%total%-%free%
echo Total: %total% MB, Used: %used% MB, Free: %free% MB

echo.
echo Log Files:
echo ---------
if exist logs\otedama.log (
    echo Latest log entries:
    powershell -Command "Get-Content logs\otedama.log -Tail 5" 2>nul
) else (
    echo No log file found
)

echo.
echo ========================================
echo Press Ctrl+C to exit monitoring
echo Refreshing in 10 seconds...
echo ========================================

timeout /t 10 /nobreak >nul
goto loop
