#!/bin/bash

# Otedama Quick Start Script
# This script helps you get started with Otedama quickly

echo "========================================="
echo "       Otedama Quick Start"
echo "========================================="
echo

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed"
    echo "Please install Node.js 18.0.0 or higher"
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2)
REQUIRED_VERSION="18.0.0"

if [ "$(printf '%s\n' "$REQUIRED_VERSION" "$NODE_VERSION" | sort -V | head -n1)" != "$REQUIRED_VERSION" ]; then
    echo "Error: Node.js version $NODE_VERSION is too old"
    echo "Please upgrade to Node.js 18.0.0 or higher"
    exit 1
fi

echo "✓ Node.js version: $NODE_VERSION"

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "Error: npm is not installed"
    exit 1
fi

# Install dependencies
echo
echo "Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "Error: Failed to install dependencies"
    exit 1
fi

echo "✓ Dependencies installed"

# Check if configuration exists
if [ ! -f "otedama.json" ]; then
    echo
    echo "No configuration found. Creating default configuration..."
    
    # Ask for currency
    echo
    echo "Select mining currency:"
    echo "1) RVN (Ravencoin)"
    echo "2) BTC (Bitcoin)"
    echo "3) XMR (Monero)"
    echo "4) LTC (Litecoin)"
    echo "5) DOGE (Dogecoin)"
    read -p "Enter choice (1-5): " CURRENCY_CHOICE
    
    case $CURRENCY_CHOICE in
        1) CURRENCY="RVN"; ALGO="kawpow" ;;
        2) CURRENCY="BTC"; ALGO="sha256" ;;
        3) CURRENCY="XMR"; ALGO="randomx" ;;
        4) CURRENCY="LTC"; ALGO="scrypt" ;;
        5) CURRENCY="DOGE"; ALGO="scrypt" ;;
        *) CURRENCY="RVN"; ALGO="kawpow" ;;
    esac
    
    # Ask for wallet address
    echo
    read -p "Enter your $CURRENCY wallet address: " WALLET
    
    if [ -z "$WALLET" ]; then
        echo "Error: Wallet address is required"
        exit 1
    fi
    
    # Create configuration
    node index.js --wallet "$WALLET" --currency "$CURRENCY" --algorithm "$ALGO"
    
    echo "✓ Configuration created"
fi

# Display current configuration
echo
echo "Current configuration:"
node index.js config

# Ask to start
echo
read -p "Start Otedama now? (y/n): " START_NOW

if [ "$START_NOW" = "y" ] || [ "$START_NOW" = "Y" ]; then
    echo
    echo "Starting Otedama..."
    echo "Dashboard: http://localhost:8080"
    echo "Press Ctrl+C to stop"
    echo
    npm start
else
    echo
    echo "To start Otedama later, run:"
    echo "  npm start"
    echo
    echo "Or with custom options:"
    echo "  node index.js --wallet YOUR_WALLET --currency RVN"
fi
