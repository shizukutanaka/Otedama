@echo off
REM Stop script for Otedama - Windows
TITLE Otedama Stop

echo ========================================
echo    Stopping Otedama Mining Software
echo ========================================
echo.

REM Check if Otedama is running as a service
sc query Otedama >nul 2>&1
if %errorlevel% equ 0 (
    echo Stopping Otedama service...
    sc stop Otedama
    timeout /t 3 /nobreak >nul
    
    sc query Otedama | findstr "STOPPED" >nul
    if %errorlevel% equ 0 (
        echo Service stopped successfully.
    ) else (
        echo WARNING: Service may still be running.
    )
) else (
    echo Otedama service not found.
)

REM Find and kill Otedama process
echo.
echo Looking for Otedama processes...

tasklist | findstr /i "otedama.exe" >nul 2>&1
if %errorlevel% equ 0 (
    echo Found Otedama process, terminating...
    
    REM Try graceful shutdown first
    taskkill /IM otedama.exe >nul 2>&1
    timeout /t 2 /nobreak >nul
    
    REM Check if still running
    tasklist | findstr /i "otedama.exe" >nul 2>&1
    if %errorlevel% equ 0 (
        echo Process still running, forcing termination...
        taskkill /F /IM otedama.exe >nul 2>&1
    )
    
    echo Otedama stopped.
) else (
    echo No Otedama process found.
)

REM Clean up PID file if exists
if exist otedama.pid (
    del otedama.pid
    echo PID file removed.
)

REM Check ports
echo.
echo Checking if ports are released...
netstat -an | findstr ":8080" >nul 2>&1
if %errorlevel% neq 0 (
    echo Port 8080 (API) is free.
) else (
    echo WARNING: Port 8080 may still be in use.
)

netstat -an | findstr ":18555" >nul 2>&1
if %errorlevel% neq 0 (
    echo Port 18555 (P2P) is free.
) else (
    echo WARNING: Port 18555 may still be in use.
)

echo.
echo ========================================
echo    Otedama has been stopped
echo ========================================
echo.

pause
