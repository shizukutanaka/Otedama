#!/bin/bash

# Otedama ゼロ手数料マイニングプール
# 最高優先度機能統合版 起動スクリプト

echo "🚀 Starting Otedama Enhanced Mining Pool..."
echo ""

# 環境変数設定
if [ ! -f .env ]; then
    echo "⚠️ .env file not found. Copying from .env.example..."
    cp .env.example .env
    echo "✅ Please edit .env file with your wallet address before starting!"
    echo "📝 nano .env"
    exit 1
fi

# Node.js バージョンチェック
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 18+ required. Current version: $(node -v)"
    exit 1
fi

# 依存関係チェック
if [ ! -d node_modules ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# TypeScript コンパイル
echo "🔨 Compiling TypeScript..."
npm run build 2>/dev/null || echo "⚠️ Build failed, running with ts-node"

# 必須設定チェック
source .env
if [ -z "$POOL_ADDRESS" ] || [ "$POOL_ADDRESS" = "YOUR_WALLET_ADDRESS_HERE" ]; then
    echo "❌ POOL_ADDRESS must be set in .env file"
    echo "📝 Edit .env and set your wallet address"
    exit 1
fi

# ポート使用状況チェック
STRATUM_V2_PORT=${STRATUM_V2_PORT:-3334}
WEB_UI_PORT=${WEB_UI_PORT:-3001}
P2P_PORT=${P2P_PORT:-4334}

check_port() {
    if netstat -tuln 2>/dev/null | grep -q ":$1 "; then
        echo "⚠️ Port $1 is already in use"
        return 1
    fi
    return 0
}

echo "🔍 Checking ports..."
check_port $STRATUM_V2_PORT || exit 1
check_port $WEB_UI_PORT || exit 1
check_port $P2P_PORT || exit 1

# ディレクトリ作成
mkdir -p logs data/shares data/blocks

echo ""
echo "🎯 Starting Enhanced Otedama System..."
echo "📊 Features:"
echo "  ✅ Stratum V2 (50% bandwidth savings)"
echo "  ✅ Multi-algorithm (RandomX, KawPow, SHA256d, Ethash)"
echo "  ✅ Real-time revenue calculation"
echo "  ✅ Auto profit switching"
echo "  ✅ One-click setup"
echo "  ✅ Zero fees (0%)"
echo ""

# メインプロセス起動
if [ -f dist/main-enhanced-priority.js ]; then
    echo "🚀 Starting compiled version..."
    node dist/main-enhanced-priority.js
else
    echo "🚀 Starting with ts-node..."
    npx ts-node src/main-enhanced-priority.ts
fi