#!/bin/bash
# Otedama Setup Script for Linux/macOS
# Automatically runs the Node.js setup script

echo "==============================================="
echo " Otedama Mining Pool Setup - Linux/macOS"
echo " Version 1.1.1 - Enterprise Edition"
echo "==============================================="
echo

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}[ERROR] Node.js is not installed!${NC}"
    echo
    echo "Please install Node.js 18.0.0 or higher:"
    
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "  brew install node"
        echo "  or download from https://nodejs.org/"
    else
        echo "  Ubuntu/Debian: sudo apt-get install nodejs"
        echo "  RHEL/CentOS: sudo yum install nodejs"
        echo "  or download from https://nodejs.org/"
    fi
    echo
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node --version)
echo -e "${GREEN}[INFO] Found Node.js $NODE_VERSION${NC}"

# Check npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}[ERROR] npm is not installed!${NC}"
    echo "Please install npm or reinstall Node.js"
    exit 1
fi

# Make setup.js executable
chmod +x setup.js

# Check if running as root (for system optimizations)
if [ "$EUID" -eq 0 ]; then 
   echo -e "${YELLOW}[INFO] Running as root - system optimizations will be applied${NC}"
else
   echo -e "${YELLOW}[INFO] Not running as root - some optimizations may be skipped${NC}"
   echo -e "${YELLOW}      Run with sudo for full system optimization${NC}"
fi

echo
echo "Starting Otedama setup..."
echo

# Run the setup script
node setup.js

echo
echo "==============================================="
echo " Setup process completed!"
echo "==============================================="
echo