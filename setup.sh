#!/bin/bash

echo ""
echo "============================================"
echo "     Otedama Setup Wizard - Linux/macOS"
echo "============================================"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed!"
    echo ""
    echo "Please install Node.js:"
    echo "  Ubuntu/Debian: sudo apt install nodejs npm"
    echo "  macOS: brew install node"
    echo "  Or download from: https://nodejs.org/"
    echo ""
    exit 1
fi

echo "[OK] Node.js is installed"
echo ""

# Check if npm modules are installed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    echo "This may take a few minutes on first run."
    echo ""
    npm install
    if [ $? -ne 0 ]; then
        echo ""
        echo "[ERROR] Failed to install dependencies"
        exit 1
    fi
fi

echo ""
echo "Starting Otedama Setup Wizard..."
echo ""

# Run the setup wizard
node index.js --setup

echo ""
echo "============================================"
echo "Setup complete!"
echo ""
echo "To start mining, run: ./start-otedama.sh"
echo "============================================"
echo ""