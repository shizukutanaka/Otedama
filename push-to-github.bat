@echo off
echo ========================================
echo Otedama v1.1.2 - GitHub Push Script
echo ========================================
echo.

echo Checking git status...
git status

echo.
echo Adding all changes...
git add .

echo.
echo Creating commit...
git commit -m "Release v1.1.2 - Production-Ready P2P Mining Platform with ZKP Auth"

echo.
echo Pushing to GitHub...
git push origin main

echo.
echo ========================================
echo Push completed!
echo ========================================
pause