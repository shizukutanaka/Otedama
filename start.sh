#!/bin/bash
# Otedama Quick Start for Linux/macOS
# Automatically detects best mode and starts the pool

echo "==============================================="
echo " Otedama Mining Pool"
echo " Version 1.1.1 - Enterprise Edition"
echo "==============================================="
echo

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed!"
    echo "Please run ./setup.sh first."
    exit 1
fi

# Make start.js executable
chmod +x start.js

# Run the start script
exec node start.js "$@"