#!/bin/bash

# Otedama Minimal Setup
echo "⚡ Otedama Setup - Single File Edition"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Install Node.js 16+ from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 16 ]; then
    echo "❌ Node.js version too old: $(node -v). Requires 16+"
    exit 1
fi

echo "✅ Node.js $(node -v)"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ Failed to install dependencies"
    exit 1
fi

# Create directories
mkdir -p data

echo ""
echo "🎉 Setup complete!"
echo ""
echo "Quick start:"
echo "  npm start                    # Start mining pool"
echo "  npm run config               # Show config"
echo "  npm test                     # Run test"
echo ""
echo "Dashboard: http://localhost:8080"
echo "Stratum:   stratum+tcp://localhost:3333"
echo ""
echo "⚙️ Edit config.json to set your wallet address"
