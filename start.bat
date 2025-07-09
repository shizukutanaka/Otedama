@echo off
echo 🌟 Otedama v2.1.0 - World's First True Zero-Fee Mining Pool
echo 🚀 Starting unified mining system...
echo.

REM Node.jsの確認
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js not found. Please install Node.js 18+ from https://nodejs.org
    pause
    exit /b 1
)

REM 依存関係の確認とインストール
if not exist node_modules (
    echo 📦 Installing dependencies...
    npm install
    if errorlevel 1 (
        echo ❌ Failed to install dependencies
        pause
        exit /b 1
    )
)

REM TypeScriptビルド
echo 🔧 Building Otedama...
npm run build
if errorlevel 1 (
    echo ❌ Build failed
    pause
    exit /b 1
)

echo.
echo ✅ Build complete! Starting Otedama...
echo 📊 Features: Stratum V2, AI Optimization, 100 Languages, Zero Fees
echo 🎯 Quick Start: Auto-setup enabled for optimal mining
echo.

REM 統合アプリケーション開始
npm run start:quick

if errorlevel 1 (
    echo.
    echo ❌ Otedama failed to start
    echo 💡 Try running: npm run start:demo
    pause
    exit /b 1
)

echo.
echo ✅ Otedama started successfully!
pause