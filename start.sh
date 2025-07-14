#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Banner
echo -e "${CYAN}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                                                              ║"
echo "║                    Otedama Commercial Pro                    ║"
echo "║                      Version 6.0.0                          ║"
echo "║                                                              ║"
echo "║           Enterprise P2P Mining Pool + DeFi Platform        ║"
echo "║                                                              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo

# Function to check command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to get Node.js major version
get_node_version() {
    node -v 2>/dev/null | sed 's/v//' | cut -d'.' -f1
}

# Check Node.js installation
echo -e "${BLUE}[1/5]${NC} Checking Node.js installation..."
if ! command_exists node; then
    echo -e "${RED}❌ ERROR: Node.js not found!${NC}"
    echo
    echo "Please install Node.js 18+ using one of these methods:"
    echo
    echo "Ubuntu/Debian:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -"
    echo "  sudo apt-get install -y nodejs"
    echo
    echo "CentOS/RHEL/Fedora:"
    echo "  curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -"
    echo "  sudo yum install -y nodejs"
    echo
    echo "Or download from: https://nodejs.org"
    echo
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(get_node_version)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}❌ ERROR: Node.js 18+ required. Current version: v$NODE_VERSION${NC}"
    echo
    echo "Please update Node.js to version 18 or higher."
    echo "Visit: https://nodejs.org"
    exit 1
fi
echo -e "${GREEN}✅ Node.js v$NODE_VERSION detected${NC}"

# Check dependencies
echo -e "${BLUE}[2/5]${NC} Checking dependencies..."
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}📦 Installing dependencies...${NC}"
    if ! npm install; then
        echo -e "${RED}❌ Failed to install dependencies${NC}"
        exit 1
    fi
    echo -e "${GREEN}✅ Dependencies installed${NC}"
else
    echo -e "${GREEN}✅ Dependencies already installed${NC}"
fi

# Create required directories
echo -e "${BLUE}[3/5]${NC} Creating directories..."
mkdir -p data logs
echo -e "${GREEN}✅ Directories created${NC}"

# Check configuration
echo -e "${BLUE}[4/5]${NC} Checking configuration..."
if [ ! -f "otedama.json" ]; then
    echo -e "${YELLOW}⚠️  Configuration file not found, creating default...${NC}"
    node index.js config >/dev/null 2>&1
fi

# Check if wallet is configured
if ! grep -q '"walletAddress".*[a-zA-Z0-9]' otedama.json; then
    echo
    echo -e "${YELLOW}⚙️  FIRST-TIME SETUP REQUIRED${NC}"
    echo
    echo "To start mining, you need to configure your wallet address."
    echo
    read -p "Would you like to configure it now? (y/n): " configure_now
    if [[ $configure_now =~ ^[Yy]$ ]]; then
        echo
        echo "Supported currencies:"
        echo "  • BTC  - Bitcoin"
        echo "  • RVN  - Ravencoin  (recommended)"
        echo "  • ETH  - Ethereum Classic"
        echo "  • XMR  - Monero"
        echo "  • LTC  - Litecoin"
        echo "  • DOGE - Dogecoin"
        echo
        read -p "Enter currency (default: RVN): " currency
        currency=${currency:-RVN}
        echo
        read -p "Enter your $currency wallet address: " wallet
        echo
        echo "Configuring wallet..."
        node index.js --currency "$currency" --wallet "$wallet"
        echo
    fi
else
    echo -e "${GREEN}✅ Wallet configured${NC}"
fi

# Start Otedama
echo -e "${BLUE}[5/5]${NC} Starting Otedama Commercial Pro..."
echo
echo -e "${GREEN}🚀 Launching with immutable operator fee system${NC}"
echo -e "${PURPLE}💰 BTC Address: bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh${NC}"
echo -e "${PURPLE}📊 Fee Rate: 0.1% (FIXED)${NC}"
echo
echo -e "${YELLOW}Press Ctrl+C to stop the service${NC}"
echo

# Handle Ctrl+C gracefully
trap 'echo -e "\n${YELLOW}🛑 Shutting down Otedama...${NC}"; exit 0' INT

# Start the application
node index.js

# If we reach here, the application has stopped
echo
echo -e "${YELLOW}🛑 Otedama has stopped${NC}"
echo
