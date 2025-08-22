@echo off
REM Start script for Otedama - Windows
TITLE Otedama Mining Software

echo ========================================
echo    Otedama - P2P Mining Software
echo ========================================
echo.

REM Check if binary exists
if not exist build\bin\otedama.exe (
    echo ERROR: Otedama binary not found!
    echo Please run build.bat first
    pause
    exit /b 1
)

REM Check if config exists
if not exist config.yaml (
    if exist config.yaml.example (
        echo Creating configuration from example...
        copy config.yaml.example config.yaml
        echo.
        echo IMPORTANT: Please edit config.yaml with your wallet address and pool settings!
        echo.
        notepad config.yaml
        pause
    ) else (
        echo ERROR: Configuration file not found!
        echo Please create config.yaml
        pause
        exit /b 1
    )
)

REM Set default options
set DEBUG_MODE=
set P2P_MODE=
set CPU_ONLY=
set GPU_ONLY=
set BENCHMARK=

REM Parse command line arguments
:parse_args
if "%1"=="" goto start_mining
if /i "%1"=="debug" set DEBUG_MODE=-debug
if /i "%1"=="p2p" set P2P_MODE=-p2p
if /i "%1"=="cpu" set CPU_ONLY=-cpu
if /i "%1"=="gpu" set GPU_ONLY=-gpu
if /i "%1"=="benchmark" set BENCHMARK=-benchmark
shift
goto parse_args

:start_mining
echo Starting Otedama...
echo.

REM Display configuration
echo Configuration:
echo - Config file: config.yaml
if defined DEBUG_MODE echo - Debug mode: ENABLED
if defined P2P_MODE echo - P2P mode: ENABLED
if defined CPU_ONLY echo - CPU mining only
if defined GPU_ONLY echo - GPU mining only
if defined BENCHMARK echo - Benchmark mode
echo.

REM Create required directories
if not exist data mkdir data
if not exist logs mkdir logs

REM Start Otedama
if defined BENCHMARK (
    echo Running benchmark...
    echo.
    build\bin\otedama.exe -benchmark
) else (
    echo Starting mining...
    echo Press Ctrl+C to stop
    echo.
    build\bin\otedama.exe -config config.yaml %DEBUG_MODE% %P2P_MODE% %CPU_ONLY% %GPU_ONLY%
)

echo.
echo Otedama stopped.
pause
