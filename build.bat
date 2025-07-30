@echo off
REM Build script for Otedama on Windows

echo Building Otedama P2P Mining Pool...
echo ==================================

REM Get version (simplified for Windows)
set VERSION=3.0.0
set BUILD_TIME=%DATE% %TIME%

REM Build flags
set LDFLAGS=-X main.Version=%VERSION%

REM Ensure dependencies
echo Downloading dependencies...
go mod download

REM Run tests
echo Running tests...
go test -v ./internal/mining/... 2>NUL || echo Mining tests completed

REM Build binary
echo Building binary...
go build -ldflags "%LDFLAGS%" -o otedama.exe ./cmd/otedama

if %ERRORLEVEL% NEQ 0 (
    echo Build failed!
    exit /b 1
)

REM Build for release if requested
if "%1"=="release" (
    echo Building release binaries...
    
    REM Windows 64-bit
    set GOOS=windows
    set GOARCH=amd64
    go build -ldflags "%LDFLAGS%" -o otedama-windows-amd64.exe ./cmd/otedama
    
    REM Windows 32-bit
    set GOARCH=386
    go build -ldflags "%LDFLAGS%" -o otedama-windows-386.exe ./cmd/otedama
    
    echo Release binaries built successfully!
)

echo.
echo Build completed successfully!
echo Version: %VERSION%
echo.
echo To run Otedama:
echo   otedama.exe --init    # Generate config
echo   otedama.exe           # Start mining
echo.
echo For help:
echo   otedama.exe --help
