@echo off
setlocal enabledelayedexpansion

echo ========================================
echo Otedama Mining Engine Test Suite
echo ========================================

echo Starting comprehensive mining engine tests...
echo.

REM Check if Go is available
where go >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: Go is not found in PATH
    echo Please install Go and ensure it's in your PATH
    pause
    exit /b 1
)

echo Go version:
go version
echo.

REM Run go mod tidy to ensure dependencies are correct
echo Updating dependencies...
go mod tidy
if %errorlevel% neq 0 (
    echo Warning: go mod tidy failed, but continuing...
)
echo.

REM Run individual test suites
echo Running CPU manager tests...
go test -v ./internal/mining -run TestCPUManager
echo.

echo Running GPU manager tests...
go test -v ./internal/mining -run TestGPUManager
echo.

echo Running ASIC manager tests...
go test -v ./internal/mining -run TestASICManager
echo.

echo Running engine tests...
go test -v ./internal/mining -run TestEngine
if %errorlevel% neq 0 (
    echo Engine tests failed
    pause
    exit /b 1
)
echo.

echo Running multi-device integration tests...
go test -v ./internal/mining -run TestMultiDeviceMiningEngine
echo.

echo Running device management tests...
go test -v ./internal/mining -run TestDeviceManagement
echo.

echo Running algorithm switching tests...
go test -v ./internal/mining -run TestAlgorithmSwitching
echo.

echo Running performance optimization tests...
go test -v ./internal/mining -run TestPerformanceOptimization
echo.

echo Running error handling tests...
go test -v ./internal/mining -run TestErrorHandling
echo.

echo Running concurrent operations tests...
go test -v ./internal/mining -run TestConcurrentOperations
echo.

echo Running benchmark suite tests...
go test -v ./internal/mining -run TestBenchmarkSuite
echo.

REM Run all tests with race detection
echo Running all tests with race detection...
go test -v -race ./internal/mining/...
echo.

REM Run benchmarks
echo Running benchmarks...
go test -v -bench=. ./internal/mining/...
echo.

echo ========================================
echo All mining engine tests completed!
echo ========================================
pause
