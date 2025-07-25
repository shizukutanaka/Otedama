#!/bin/bash
# Otedama Mining Pool - Quick Start Script

echo "Starting Otedama Mining Pool..."

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed"
    exit 1
fi

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Check for .env file
if [ ! -f ".env" ]; then
    echo "Creating .env file from example..."
    cp .env.example .env
    echo "Please edit .env file with your configuration"
    exit 1
fi

# Check for config file
if [ ! -f "otedama.config.js" ]; then
    echo "Creating config file from example..."
    cp otedama.config.example.js otedama.config.js
fi

# Start the pool
echo "Starting mining pool..."
node start-mining-pool.js "$@"
