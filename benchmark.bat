@echo off
REM Benchmark script for Otedama - Hardware Performance Testing
TITLE Otedama Benchmark Suite

echo ========================================
echo    Otedama - Benchmark Suite
echo ========================================
echo.
echo This will test your hardware's mining performance
echo across different algorithms.
echo.

REM Check if binary exists
if not exist build\bin\otedama.exe (
    echo Building Otedama first...
    call build.bat
    if %errorlevel% neq 0 (
        echo ERROR: Build failed
        pause
        exit /b 1
    )
)

echo Starting benchmark...
echo.
echo ========================================
echo    System Information
echo ========================================
echo.
echo Computer Name: %COMPUTERNAME%
echo Processor: %PROCESSOR_IDENTIFIER%
echo Number of Cores: %NUMBER_OF_PROCESSORS%
echo Architecture: %PROCESSOR_ARCHITECTURE%
echo.

REM Create benchmark results directory
set RESULTS_DIR=benchmark_results
if not exist %RESULTS_DIR% mkdir %RESULTS_DIR%

REM Get timestamp for results file
for /f "tokens=2-4 delims=/ " %%a in ('date /t') do (set TODAY=%%c%%a%%b)
for /f "tokens=1-2 delims=: " %%a in ('time /t') do (set NOW=%%a%%b)
set TIMESTAMP=%TODAY%_%NOW: =%
set RESULTS_FILE=%RESULTS_DIR%\benchmark_%TIMESTAMP%.txt

echo Results will be saved to: %RESULTS_FILE%
echo.

REM Run benchmark
echo ========================================
echo    Running Algorithm Benchmarks
echo ========================================
echo.

(
echo Otedama Benchmark Results
echo ========================
echo Date: %date% %time%
echo System: %COMPUTERNAME%
echo Processor: %PROCESSOR_IDENTIFIER%
echo Cores: %NUMBER_OF_PROCESSORS%
echo.
echo Algorithm Benchmarks:
echo ---------------------
) > %RESULTS_FILE%

REM Test each algorithm
set ALGORITHMS=sha256d scrypt ethash randomx cryptonight x11 blake2b

for %%A in (%ALGORITHMS%) do (
    echo.
    echo Testing %%A algorithm...
    echo.
    
    echo. >> %RESULTS_FILE%
    echo Algorithm: %%A >> %RESULTS_FILE%
    echo -------------- >> %RESULTS_FILE%
    
    REM Run benchmark for this algorithm
    build\bin\otedama.exe -benchmark -algorithm %%A 2>&1 | findstr /C:"H/s" >> %RESULTS_FILE%
    
    if %errorlevel% equ 0 (
        echo %%A: Test completed
    ) else (
        echo %%A: Test failed or not supported
        echo Failed or not supported >> %RESULTS_FILE%
    )
)

echo.
echo ========================================
echo    CPU vs GPU Performance Test
echo ========================================
echo.

REM CPU-only test
echo Testing CPU-only performance...
(
echo.
echo CPU-Only Performance:
echo --------------------
) >> %RESULTS_FILE%

build\bin\otedama.exe -benchmark -cpu 2>&1 | findstr /C:"H/s" >> %RESULTS_FILE%

REM GPU-only test (if available)
echo Testing GPU-only performance (if available)...
(
echo.
echo GPU-Only Performance:
echo --------------------
) >> %RESULTS_FILE%

build\bin\otedama.exe -benchmark -gpu 2>&1 | findstr /C:"H/s" >> %RESULTS_FILE%
if %errorlevel% neq 0 (
    echo No GPU detected or GPU mining not available >> %RESULTS_FILE%
)

echo.
echo ========================================
echo    Power Efficiency Test
echo ========================================
echo.

REM Test different power modes
set POWER_MODES=efficiency balanced performance turbo

for %%M in (%POWER_MODES%) do (
    echo.
    echo Testing %%M power mode...
    
    (
    echo.
    echo Power Mode: %%M
    echo ----------------
    ) >> %RESULTS_FILE%
    
    build\bin\otedama.exe -benchmark -power-mode %%M 2>&1 | findstr /C:"H/s" /C:"W" >> %RESULTS_FILE%
)

echo.
echo ========================================
echo    Memory Usage Analysis
echo ========================================
echo.

(
echo.
echo Memory Usage:
echo ------------
) >> %RESULTS_FILE%

REM Get memory usage during mining
echo Testing memory consumption...
build\bin\otedama.exe -benchmark -duration 10 2>&1 | findstr /C:"Memory" >> %RESULTS_FILE%

echo.
echo ========================================
echo    Benchmark Summary
echo ========================================
echo.

REM Display summary
type %RESULTS_FILE% | findstr /C:"H/s" /C:"Algorithm:"

echo.
echo ========================================
echo    Benchmark Complete!
echo ========================================
echo.
echo Full results saved to: %RESULTS_FILE%
echo.

REM Generate comparison chart (simple text-based)
echo Performance Comparison:
echo ----------------------
echo.
echo Algorithm      Hashrate
echo ---------      --------
type %RESULTS_FILE% | findstr /C:"H/s"

echo.
echo Recommendations:
echo ---------------

REM Simple recommendations based on results
echo 1. Use the algorithm with the highest hashrate for your hardware
echo 2. Consider power efficiency when choosing settings
echo 3. Monitor temperatures during actual mining
echo 4. Adjust intensity settings based on stability
echo.

REM Optional: Upload results for comparison
echo Would you like to save these results for future comparison? (Y/N)
set /p SAVE_RESULTS=

if /i "%SAVE_RESULTS%"=="Y" (
    copy %RESULTS_FILE% %RESULTS_DIR%\latest_benchmark.txt >nul
    echo Results saved as latest_benchmark.txt
)

echo.
pause
