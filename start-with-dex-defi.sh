#!/bin/bash

echo "Starting Otedama with DEX and DeFi features..."
echo

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed. Please install Node.js first."
    echo "Download from: https://nodejs.org/"
    exit 1
fi

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "Error: Failed to install dependencies"
        exit 1
    fi
fi

# Start Otedama with all features
echo "Starting Otedama..."
echo
echo "Features enabled:"
echo "- P2P Mining Pool"
echo "- Decentralized Exchange (DEX)"
echo "- DeFi (Yield Farming, Lending, Staking)"
echo
echo "Access the web interface at: http://localhost:8080"
echo "API endpoints available at: http://localhost:8080/api/v1"
echo
echo "Press Ctrl+C to stop"
echo

node index.js --standalone --enable-dex --enable-defi --coinbase-address YOUR_WALLET_ADDRESS