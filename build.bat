@echo off
REM Build script for Otedama - Windows
TITLE Otedama Build

echo ========================================
echo    Otedama - Build Script
echo ========================================
echo.

REM Check if Go is installed
where go >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Go is not installed or not in PATH
    echo Please install Go from https://golang.org/dl/
    pause
    exit /b 1
)

REM Display Go version
echo Go version:
go version
echo.

REM Set build variables
set BINARY_NAME=otedama.exe
set BINARY_DIR=build\bin
set SOURCE_DIR=cmd\otedama
set VERSION=Otedama
set BUILD_TIME=%date% %time%

REM Set build flags
set LDFLAGS=-s -w -X 'main.Version=%VERSION%' -X 'main.BuildTime=%BUILD_TIME%'
set GCFLAGS=-l=4

echo Building Otedama...
echo.

REM Create build directory
if not exist %BINARY_DIR% (
    mkdir %BINARY_DIR%
)

REM Download dependencies
echo Downloading dependencies...
go mod download
if %errorlevel% neq 0 (
    echo ERROR: Failed to download dependencies
    pause
    exit /b 1
)

REM Verify dependencies
echo Verifying dependencies...
go mod verify
if %errorlevel% neq 0 (
    echo ERROR: Failed to verify dependencies
    pause
    exit /b 1
)

REM Tidy dependencies
echo Tidying dependencies...
go mod tidy
if %errorlevel% neq 0 (
    echo WARNING: Failed to tidy dependencies
)

echo.
echo Compiling...

REM Build the binary
go build -v -ldflags "%LDFLAGS%" -gcflags="%GCFLAGS%" -trimpath -o %BINARY_DIR%\%BINARY_NAME% %SOURCE_DIR%\*.go

if %errorlevel% neq 0 (
    echo.
    echo ERROR: Build failed!
    pause
    exit /b 1
)

echo.
echo ========================================
echo    Build completed successfully!
echo ========================================
echo.
echo Binary location: %BINARY_DIR%\%BINARY_NAME%
echo.

REM Copy config file if it doesn't exist
if not exist config.yaml (
    if exist config.yaml.example (
        echo Copying example configuration...
        copy config.yaml.example config.yaml
        echo Configuration file created: config.yaml
        echo Please edit config.yaml with your settings
        echo.
    )
)

REM Create data directory
if not exist data (
    mkdir data
    echo Created data directory
)

REM Create logs directory
if not exist logs (
    mkdir logs
    echo Created logs directory
)

echo.
echo To start mining, run: start.bat
echo Or run directly: %BINARY_DIR%\%BINARY_NAME%
echo.

pause
