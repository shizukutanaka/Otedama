#!/bin/bash
# Otedama Pool systemd installation script

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
POOL_USER="pooluser"
POOL_GROUP="pooluser"
INSTALL_DIR="/opt/otedama-pool"
SERVICE_NAME="otedama-pool"

echo -e "${GREEN}Otedama Pool Systemd Installation Script${NC}"
echo "========================================"

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}Please run as root (use sudo)${NC}"
    exit 1
fi

# Create pool user if not exists
if ! id "$POOL_USER" &>/dev/null; then
    echo -e "${YELLOW}Creating user: $POOL_USER${NC}"
    useradd -r -s /bin/false -m -d /var/lib/$POOL_USER $POOL_USER
fi

# Create installation directory
echo -e "${YELLOW}Creating installation directory: $INSTALL_DIR${NC}"
mkdir -p $INSTALL_DIR
mkdir -p $INSTALL_DIR/data
mkdir -p $INSTALL_DIR/logs

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}Node.js is not installed!${NC}"
    echo "Please install Node.js 18 or higher"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}Node.js version must be 18 or higher${NC}"
    echo "Current version: $(node -v)"
    exit 1
fi

# Copy application files
echo -e "${YELLOW}Copying application files...${NC}"
if [ -d "dist" ]; then
    cp -r dist $INSTALL_DIR/
else
    echo -e "${RED}Build directory not found. Please run 'npm run build' first${NC}"
    exit 1
fi

# Copy necessary files
cp package.json $INSTALL_DIR/
cp package-lock.json $INSTALL_DIR/ 2>/dev/null || true
cp -r node_modules $INSTALL_DIR/ 2>/dev/null || true

# Copy environment file template
if [ -f ".env.example" ]; then
    cp .env.example $INSTALL_DIR/.env.example
    if [ ! -f "$INSTALL_DIR/.env" ]; then
        cp .env.example $INSTALL_DIR/.env
        echo -e "${YELLOW}Created .env file from template${NC}"
        echo -e "${RED}Please edit $INSTALL_DIR/.env with your configuration${NC}"
    fi
fi

# Set permissions
echo -e "${YELLOW}Setting permissions...${NC}"
chown -R $POOL_USER:$POOL_GROUP $INSTALL_DIR
chmod 750 $INSTALL_DIR
chmod 640 $INSTALL_DIR/.env 2>/dev/null || true

# Install dependencies if needed
if [ ! -d "$INSTALL_DIR/node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    cd $INSTALL_DIR
    sudo -u $POOL_USER npm install --production
    cd -
fi

# Copy systemd service file
echo -e "${YELLOW}Installing systemd service...${NC}"
cp scripts/otedama-pool.service /etc/systemd/system/

# Update service file with correct paths
sed -i "s|/opt/otedama-pool|$INSTALL_DIR|g" /etc/systemd/system/$SERVICE_NAME.service
sed -i "s|pooluser|$POOL_USER|g" /etc/systemd/system/$SERVICE_NAME.service

# Reload systemd
systemctl daemon-reload

# Enable service
echo -e "${YELLOW}Enabling service...${NC}"
systemctl enable $SERVICE_NAME

echo -e "${GREEN}Installation complete!${NC}"
echo ""
echo "Next steps:"
echo "1. Edit configuration: sudo nano $INSTALL_DIR/.env"
echo "2. Start the service: sudo systemctl start $SERVICE_NAME"
echo "3. Check status: sudo systemctl status $SERVICE_NAME"
echo "4. View logs: sudo journalctl -u $SERVICE_NAME -f"
echo "5. Check health: curl http://localhost:3001/health"
echo ""
echo "Useful commands:"
echo "- Restart: sudo systemctl restart $SERVICE_NAME"
echo "- Stop: sudo systemctl stop $SERVICE_NAME"
echo "- Disable: sudo systemctl disable $SERVICE_NAME"
echo "- Logs: sudo journalctl -u $SERVICE_NAME --since today"
