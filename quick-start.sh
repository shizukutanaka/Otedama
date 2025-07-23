#!/bin/bash
# Otedama Quick Start - One-click mining for beginners
# This script automatically sets up and starts mining with minimal configuration

clear
echo ""
echo "===================================================="
echo "      Otedama Quick Start - Beginner Mining"
echo "===================================================="
echo ""
echo "This will automatically set up mining with the"
echo "following configuration:"
echo ""
echo "  - Mode: Standalone (Solo mining)"
echo "  - Pool fee: 1% (Industry lowest!)"
echo "  - Auto-switch to pool mode when others join"
echo "  - All other settings: Automatic"
echo ""
echo "===================================================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed!"
    echo ""
    echo "Would you like to:"
    echo "  1. See installation instructions"
    echo "  2. Exit and install manually"
    echo ""
    read -p "Select option (1-2): " choice
    
    if [ "$choice" = "1" ]; then
        echo ""
        echo "To install Node.js:"
        echo ""
        echo "Ubuntu/Debian:"
        echo "  sudo apt update && sudo apt install nodejs npm"
        echo ""
        echo "macOS:"
        echo "  brew install node"
        echo ""
        echo "Or download from: https://nodejs.org/"
        echo ""
    fi
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing Otedama... This may take a few minutes."
    echo ""
    npm install --quiet
    if [ $? -ne 0 ]; then
        echo "[ERROR] Installation failed"
        exit 1
    fi
fi

# Check if wallet address exists
if [ ! -f "config/wallet.txt" ]; then
    echo ""
    echo "===================================================="
    echo "        IMPORTANT: Bitcoin Address Required"
    echo "===================================================="
    echo ""
    echo "Please enter your Bitcoin address to receive mining rewards."
    echo ""
    echo "Supported formats:"
    echo "  - Legacy (1...): e.g., 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
    echo "  - SegWit (3...): e.g., 3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"
    echo "  - Native SegWit (bc1...): e.g., bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
    echo ""
    read -p "Your Bitcoin address: " WALLET_ADDRESS
    
    # Save wallet address
    mkdir -p config
    echo "$WALLET_ADDRESS" > config/wallet.txt
    echo ""
    echo "Wallet address saved!"
else
    # Read existing wallet address
    WALLET_ADDRESS=$(cat config/wallet.txt)
    echo "Using saved wallet address: $WALLET_ADDRESS"
fi

echo ""
echo "Starting Otedama in beginner mode..."
echo ""

# Create simple config if it doesn't exist
if [ ! -f "config/otedama.json" ]; then
    echo "Creating configuration..."
    mkdir -p config
    cat > config/otedama.json << EOF
{
  "mode": "standalone",
  "experienceLevel": "beginner",
  "pool": {
    "port": 3333,
    "fee": 1.0,
    "minPayout": 0.001
  },
  "wallet": {
    "address": "$WALLET_ADDRESS"
  },
  "api": {
    "port": 8080,
    "enabled": true
  }
}
EOF
fi

# Make executable
chmod +x quick-start.sh 2>/dev/null

echo ""
echo "===================================================="
echo "           Mining Started Successfully!"
echo "===================================================="
echo ""
echo "  Dashboard: http://localhost:8080"
echo "  Pool Port: 3333"
echo "  Mode: Standalone (auto-scaling)"
echo ""
echo "  Your wallet: $WALLET_ADDRESS"
echo ""
echo "  Press Ctrl+C to stop mining"
echo "===================================================="
echo ""

# Set creator fee address (optional, can be removed)
export CREATOR_WALLET_ADDRESS=bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh

# Start Otedama
node index.js --config config/otedama.json --mode standalone --wallet "$WALLET_ADDRESS"