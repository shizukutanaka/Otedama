#!/bin/bash

# Otedama Deployment Script
# Unified installation and update script for Linux

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Functions
print_success() { echo -e "${GREEN}✓ $1${NC}"; }
print_error() { echo -e "${RED}✗ $1${NC}"; exit 1; }
print_info() { echo -e "${YELLOW}→ $1${NC}"; }
print_header() { echo -e "${BLUE}$1${NC}"; }

# Detect if updating or installing
MODE="install"
if [ -d "/opt/otedama" ] && [ -f "/opt/otedama/index.js" ]; then
    MODE="update"
fi

# Header
echo
print_header "========================================"
print_header "     Otedama Deployment Script"
print_header "     Mode: ${MODE^^}"
print_header "========================================"
echo

# Check permissions
if [ "$MODE" = "install" ] && [ "$EUID" -eq 0 ]; then 
    print_error "Please do not run as root for fresh install. Script will use sudo when needed."
elif [ "$MODE" = "update" ] && [ "$EUID" -ne 0 ]; then
    print_error "Update mode requires root. Please run with sudo."
fi

# Function: Install Node.js
install_nodejs() {
    if ! command -v node &> /dev/null; then
        print_info "Installing Node.js..."
        curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
        sudo apt-get install -y nodejs
        print_success "Node.js installed"
    else
        NODE_VERSION=$(node -v | cut -d'v' -f2)
        print_success "Node.js version: $NODE_VERSION"
    fi
}

# Function: Setup system
setup_system() {
    print_info "Installing system dependencies..."
    sudo apt-get update
    sudo apt-get install -y build-essential python3
    
    if ! id "otedama" &>/dev/null; then
        print_info "Creating otedama user..."
        sudo useradd -r -s /bin/bash -m -d /opt/otedama otedama
        print_success "User created"
    fi
    
    print_info "Creating directories..."
    sudo mkdir -p /opt/otedama/{data,logs,backups}
    sudo chown -R otedama:otedama /opt/otedama
    print_success "Directories created"
}

# Function: Install files
install_files() {
    print_info "Copying Otedama files..."
    sudo cp -r ./* /opt/otedama/
    sudo chown -R otedama:otedama /opt/otedama
    
    cd /opt/otedama
    print_info "Installing Node.js dependencies..."
    sudo -u otedama npm install
    print_success "Installation complete"
}

# Function: Update files
update_files() {
    print_info "Creating backup..."
    BACKUP_DIR="/opt/otedama-backup-$(date +%Y%m%d-%H%M%S)"
    cp -r /opt/otedama $BACKUP_DIR
    print_success "Backup created at $BACKUP_DIR"
    
    print_info "Updating files..."
    # Copy only necessary files, preserve config
    for file in index.js monitor.js payment.js gpu.js backup.js package.json README.md; do
        if [ -f "$file" ]; then
            cp "$file" /opt/otedama/
        fi
    done
    
    # Copy directories
    for dir in web examples docs monitoring; do
        if [ -d "$dir" ]; then
            cp -r "$dir" /opt/otedama/
        fi
    done
    
    cd /opt/otedama
    print_info "Updating dependencies..."
    npm install --production
    
    chown -R otedama:otedama /opt/otedama
    print_success "Update complete"
}

# Function: Configure
configure_otedama() {
    if [ -f "/opt/otedama/otedama.json" ]; then
        print_info "Configuration already exists"
        return
    fi
    
    print_header "\n======== Configuration ========"
    
    read -p "Enter your wallet address: " WALLET
    read -p "Enter currency (RVN/BTC/XMR/LTC/DOGE): " CURRENCY
    read -p "Enter pool name [Otedama Pool]: " POOL_NAME
    POOL_NAME=${POOL_NAME:-"Otedama Pool"}
    
    sudo -u otedama node /opt/otedama/index.js --wallet "$WALLET" --currency "$CURRENCY"
    
    CONFIG_FILE="/opt/otedama/otedama.json"
    if [ -f "$CONFIG_FILE" ]; then
        sudo -u otedama sed -i "s/\"name\": \"[^\"]*\"/\"name\": \"$POOL_NAME\"/" "$CONFIG_FILE"
    fi
    
    print_success "Configuration saved"
}

# Function: Setup service
setup_service() {
    print_info "Installing systemd service..."
    
    if [ ! -f "/opt/otedama/deploy/otedama.service" ]; then
        print_info "Creating service file..."
        sudo mkdir -p /opt/otedama/deploy
        cat << 'EOF' | sudo tee /opt/otedama/deploy/otedama.service > /dev/null
[Unit]
Description=Otedama Mining Pool
After=network.target

[Service]
Type=simple
User=otedama
WorkingDirectory=/opt/otedama
ExecStart=/usr/bin/node /opt/otedama/index.js
Restart=always
RestartSec=10
StandardOutput=append:/opt/otedama/logs/otedama.log
StandardError=append:/opt/otedama/logs/otedama-error.log

[Install]
WantedBy=multi-user.target
EOF
    fi
    
    sudo cp /opt/otedama/deploy/otedama.service /etc/systemd/system/
    sudo systemctl daemon-reload
    print_success "Service installed"
}

# Function: Setup firewall
setup_firewall() {
    if command -v ufw &> /dev/null; then
        print_info "Configuring firewall..."
        sudo ufw allow 8080/tcp comment 'Otedama API' || true
        sudo ufw allow 3333/tcp comment 'Otedama Stratum' || true
        sudo ufw allow 8333/tcp comment 'Otedama P2P' || true
        print_success "Firewall configured"
    fi
}

# Function: Setup cron jobs
setup_cron() {
    print_info "Setting up cron jobs..."
    
    # Monitor cron
    (sudo -u otedama crontab -l 2>/dev/null | grep -v "monitor.js" || true; \
     echo "*/5 * * * * /usr/bin/node /opt/otedama/monitor.js >> /opt/otedama/logs/monitor.log 2>&1") | \
     sudo -u otedama crontab -
    
    # Backup cron
    (sudo -u otedama crontab -l 2>/dev/null | grep -v "backup.js" || true; \
     echo "0 2 * * * /usr/bin/node /opt/otedama/backup.js create >> /opt/otedama/logs/backup.log 2>&1") | \
     sudo -u otedama crontab -
    
    # Payment cron (hourly)
    (sudo -u otedama crontab -l 2>/dev/null | grep -v "payment.js" || true; \
     echo "0 * * * * /usr/bin/node /opt/otedama/payment.js >> /opt/otedama/logs/payment.log 2>&1") | \
     sudo -u otedama crontab -
    
    print_success "Cron jobs configured"
}

# Function: Start service
manage_service() {
    if [ "$1" = "stop" ]; then
        print_info "Stopping Otedama service..."
        sudo systemctl stop otedama || true
        print_success "Service stopped"
    else
        print_info "Starting Otedama service..."
        sudo systemctl enable otedama
        sudo systemctl start otedama
        sleep 2
        
        if systemctl is-active --quiet otedama; then
            print_success "Service running"
        else
            print_error "Service failed to start. Check: journalctl -u otedama -f"
        fi
    fi
}

# Main execution
case "$MODE" in
    "install")
        install_nodejs
        setup_system
        install_files
        configure_otedama
        setup_service
        setup_firewall
        setup_cron
        manage_service "start"
        ;;
    
    "update")
        manage_service "stop"
        update_files
        manage_service "start"
        ;;
esac

# Display info
IP=$(hostname -I | awk '{print $1}')
echo
print_header "========================================"
print_success "${MODE^} Complete!"
print_header "========================================"
echo
echo "Dashboard: http://${IP}:8080"
echo "Stratum:  stratum+tcp://${IP}:3333"
echo
echo "Commands:"
echo "  sudo systemctl status otedama    - Check status"
echo "  sudo systemctl restart otedama   - Restart service"
echo "  sudo journalctl -u otedama -f    - View logs"
echo "  tail -f /opt/otedama/logs/*.log  - View application logs"
echo
echo "Management:"
echo "  sudo -u otedama node /opt/otedama/monitor.js    - Run monitor"
echo "  sudo -u otedama node /opt/otedama/payment.js    - Process payments"
echo "  sudo -u otedama node /opt/otedama/backup.js     - Manage backups"
echo
echo "Files:"
echo "  Config: /opt/otedama/otedama.json"
echo "  Logs:   /opt/otedama/logs/"
echo "  Data:   /opt/otedama/data/"

if [ "$MODE" = "update" ]; then
    echo "  Backup: $BACKUP_DIR"
fi

echo
