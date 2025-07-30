@echo off
cd C:\Users\irosa\Desktop\Otedama
go build -o otedama.exe ./cmd/otedama
if %errorlevel% equ 0 (
    echo Build successful!
    otedama.exe --version
) else (
    echo Build failed!
    exit /b 1
)
