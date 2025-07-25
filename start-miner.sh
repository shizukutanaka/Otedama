#!/bin/bash
# Otedama Miner - Linux/macOS Launcher

echo "==================================="
echo "    Otedama Miner"
echo "    High-Performance Mining Software"
echo "==================================="
echo

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed."
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi

# Default configuration
POOL_URL="stratum+tcp://localhost:3333"
POOL_USER="wallet.worker"
ALGORITHM="sha256"

# Check for user input
echo "Current Configuration:"
echo "Pool: $POOL_URL"
echo "User: $POOL_USER"
echo "Algorithm: $ALGORITHM"
echo

read -p "Use custom settings? (Y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    read -p "Enter pool URL: " POOL_URL
    read -p "Enter wallet address or username: " POOL_USER
    read -p "Enter algorithm (sha256/ethash/scrypt/etc): " ALGORITHM
fi

echo
echo "Starting Otedama Miner..."
echo

# Start miner
node otedama-miner.js -o "$POOL_URL" -u "$POOL_USER" -a "$ALGORITHM"