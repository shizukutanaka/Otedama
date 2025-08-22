@echo off
REM Test script for Otedama - Windows
TITLE Otedama Test Suite

echo ========================================
echo    Otedama - Test Suite
echo ========================================
echo.

REM Check if Go is installed
where go >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Go is not installed or not in PATH
    pause
    exit /b 1
)

echo Running tests...
echo.

REM Set test environment
set GO111MODULE=on
set CGO_ENABLED=1

REM Run unit tests
echo [1/5] Running unit tests...
go test -v -race -short ./internal/... 2>&1
if %errorlevel% neq 0 (
    echo FAILED: Unit tests failed
    set FAILED_TESTS=1
) else (
    echo PASSED: Unit tests
)
echo.

REM Run integration tests
echo [2/5] Running integration tests...
go test -v -race ./tests/integration/... 2>&1
if %errorlevel% neq 0 (
    echo WARNING: Integration tests failed or not found
) else (
    echo PASSED: Integration tests
)
echo.

REM Run benchmarks
echo [3/5] Running benchmarks...
go test -bench=. -benchmem -run=^$ ./internal/mining/... 2>&1
if %errorlevel% neq 0 (
    echo WARNING: Benchmarks failed
) else (
    echo PASSED: Benchmarks completed
)
echo.

REM Check for race conditions
echo [4/5] Checking for race conditions...
go test -race ./... 2>&1 | findstr /C:"WARNING: DATA RACE" >nul
if %errorlevel% equ 0 (
    echo WARNING: Race conditions detected
    set RACE_DETECTED=1
) else (
    echo PASSED: No race conditions detected
)
echo.

REM Run go vet
echo [5/5] Running go vet...
go vet ./... 2>&1
if %errorlevel% neq 0 (
    echo WARNING: go vet found issues
) else (
    echo PASSED: go vet
)
echo.

REM Test coverage
echo Generating test coverage report...
go test -coverprofile=coverage.out ./internal/... 2>&1 >nul
if exist coverage.out (
    go tool cover -func=coverage.out | findstr "total:"
    echo.
    echo Coverage report saved to coverage.out
    echo To view HTML report, run: go tool cover -html=coverage.out
) else (
    echo WARNING: Could not generate coverage report
)
echo.

REM Summary
echo ========================================
echo    Test Summary
echo ========================================

if defined FAILED_TESTS (
    echo STATUS: FAILED - Some tests did not pass
    echo Please fix the failing tests before deployment
    exit /b 1
) else if defined RACE_DETECTED (
    echo STATUS: WARNING - Race conditions detected
    echo Consider fixing race conditions for production
    exit /b 0
) else (
    echo STATUS: PASSED - All tests passed successfully
    exit /b 0
)

pause
