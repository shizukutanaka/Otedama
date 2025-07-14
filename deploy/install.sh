#!/bin/bash

# Otedama Linux Installation Script

set -e

echo "========================================"
echo "     Otedama Installation Script"
echo "========================================"
echo

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
   echo "Please do not run as root. Script will use sudo when needed."
   exit 1
fi

# Check Node.js installation
if ! command -v node &> /dev/null; then
    echo "Node.js is not installed. Installing..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2)
echo "Node.js version: $NODE_VERSION"

# Create otedama user
if ! id "otedama" &>/dev/null; then
    echo "Creating otedama user..."
    sudo useradd -r -s /bin/bash -m -d /opt/otedama otedama
fi

# Install dependencies
echo "Installing system dependencies..."
sudo apt-get update
sudo apt-get install -y build-essential python3 git

# Create directories
echo "Creating directories..."
sudo mkdir -p /opt/otedama/{data,logs,backups}
sudo chown -R otedama:otedama /opt/otedama

# Copy files
echo "Copying Otedama files..."
sudo cp -r ./* /opt/otedama/
sudo chown -R otedama:otedama /opt/otedama

# Install Node.js dependencies
echo "Installing Node.js dependencies..."
cd /opt/otedama
sudo -u otedama npm install

# Install systemd service
echo "Installing systemd service..."
sudo cp /opt/otedama/deploy/otedama.service /etc/systemd/system/
sudo systemctl daemon-reload

# Configure
echo
echo "========================================"
echo "          Configuration"
echo "========================================"
echo

read -p "Enter your wallet address: " WALLET
read -p "Enter currency (RVN/BTC/XMR/LTC/DOGE): " CURRENCY
read -p "Enter pool name [Otedama Pool]: " POOL_NAME
POOL_NAME=${POOL_NAME:-"Otedama Pool"}

# Create configuration
sudo -u otedama node /opt/otedama/index.js --wallet "$WALLET" --currency "$CURRENCY"

# Update pool name in config
CONFIG_FILE="/opt/otedama/otedama.json"
if [ -f "$CONFIG_FILE" ]; then
    sudo -u otedama sed -i "s/\"name\": \"[^\"]*\"/\"name\": \"$POOL_NAME\"/" "$CONFIG_FILE"
fi

# Set up firewall
echo "Configuring firewall..."
sudo ufw allow 8080/tcp comment 'Otedama API'
sudo ufw allow 3333/tcp comment 'Otedama Stratum'
sudo ufw allow 8333/tcp comment 'Otedama P2P'

# Enable and start service
echo "Starting Otedama service..."
sudo systemctl enable otedama
sudo systemctl start otedama

# Set up monitoring cron
echo "Setting up monitoring..."
(crontab -l 2>/dev/null; echo "*/5 * * * * /usr/bin/node /opt/otedama/monitor.js >> /opt/otedama/logs/monitor.log 2>&1") | sudo -u otedama crontab -

# Set up backup cron
echo "Setting up daily backups..."
(crontab -l 2>/dev/null; echo "0 2 * * * /usr/bin/node /opt/otedama/backup.js create >> /opt/otedama/logs/backup.log 2>&1") | sudo -u otedama crontab -

# Display status
echo
echo "========================================"
echo "     Installation Complete!"
echo "========================================"
echo
echo "Dashboard: http://$(hostname -I | awk '{print $1}'):8080"
echo "Stratum:  stratum+tcp://$(hostname -I | awk '{print $1}'):3333"
echo
echo "Commands:"
echo "  sudo systemctl status otedama    - Check status"
echo "  sudo systemctl restart otedama   - Restart service"
echo "  sudo journalctl -u otedama -f    - View logs"
echo "  sudo -u otedama node /opt/otedama/monitor.js    - Run monitor"
echo "  sudo -u otedama node /opt/otedama/payment.js    - Process payments"
echo
echo "Configuration file: /opt/otedama/otedama.json"
echo "Logs directory: /opt/otedama/logs/"
echo "Data directory: /opt/otedama/data/"
echo
