#!/bin/bash
# Otedama Mining Pool - Quick Start Script

echo "======================================"
echo "    Otedama Mining Pool Quick Start   "
echo "======================================"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed."
    echo "Please install Node.js 18+ from https://nodejs.org/"
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "Error: Node.js 18+ is required. Current version: $(node -v)"
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "Error: npm is not installed."
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "Error: Failed to install dependencies"
        exit 1
    fi
fi

# Create required directories
mkdir -p data logs

# Copy configuration files if they don't exist
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        echo "Creating .env from .env.example..."
        cp .env.example .env
        echo ""
        echo "IMPORTANT: Please edit .env and set your pool configuration:"
        echo "  - POOL_ADDRESS (your wallet address)"
        echo "  - BITCOIN_RPC_PASSWORD (your Bitcoin node password)"
        echo ""
        read -p "Press Enter after editing .env to continue..."
    else
        echo "Error: .env.example not found"
        exit 1
    fi
fi

if [ ! -f "otedama.config.js" ]; then
    if [ -f "otedama.config.example.js" ]; then
        echo "Creating otedama.config.js from example..."
        cp otedama.config.example.js otedama.config.js
    fi
fi

# Validate configuration
echo "Validating configuration..."
npm run config:validate
if [ $? -ne 0 ]; then
    echo "Error: Configuration validation failed"
    exit 1
fi

# Start the pool
echo ""
echo "Starting Otedama Mining Pool..."
echo "======================================"
echo ""

# Run with garbage collection exposed for better memory management
exec node --expose-gc start-mining-pool.js "$@"
