#!/bin/bash

# Otedama Mining Pool - Automated Installation Script
# Supports Ubuntu 20.04+ and CentOS 8+

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
INSTALL_DIR="/opt/otedama"
USER="otedama"
GROUP="otedama"
NODEJS_VERSION="18"

# Functions
print_header() {
    echo -e "${BLUE}================================================${NC}"
    echo -e "${BLUE}    Otedama Mining Pool Installer${NC}"
    echo -e "${BLUE}================================================${NC}"
    echo
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
    exit 1
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

detect_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS=$NAME
        VER=$VERSION_ID
    else
        print_error "Cannot detect OS"
    fi
}

install_dependencies() {
    echo "Installing system dependencies..."
    
    if [[ "$OS" == "Ubuntu" ]] || [[ "$OS" == "Debian"* ]]; then
        apt-get update
        apt-get install -y curl git build-essential python3 wget
    elif [[ "$OS" == "CentOS"* ]] || [[ "$OS" == "Red Hat"* ]]; then
        yum update -y
        yum install -y curl git gcc-c++ make python3 wget
    else
        print_error "Unsupported OS: $OS"
    fi
    
    print_success "System dependencies installed"
}

install_nodejs() {
    echo "Installing Node.js ${NODEJS_VERSION}..."
    
    if command -v node &> /dev/null; then
        NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_VERSION" -ge "$NODEJS_VERSION" ]; then
            print_success "Node.js $NODE_VERSION already installed"
            return
        fi
    fi
    
    curl -fsSL https://deb.nodesource.com/setup_${NODEJS_VERSION}.x | bash -
    
    if [[ "$OS" == "Ubuntu" ]] || [[ "$OS" == "Debian"* ]]; then
        apt-get install -y nodejs
    elif [[ "$OS" == "CentOS"* ]] || [[ "$OS" == "Red Hat"* ]]; then
        yum install -y nodejs
    fi
    
    print_success "Node.js $(node -v) installed"
}

create_user() {
    echo "Creating otedama user..."
    
    if id "$USER" &>/dev/null; then
        print_warning "User $USER already exists"
    else
        useradd -r -s /bin/bash -m -d /home/$USER $USER
        print_success "User $USER created"
    fi
}

setup_directories() {
    echo "Setting up directories..."
    
    mkdir -p $INSTALL_DIR/{data,logs,backups,deployments}
    chown -R $USER:$GROUP $INSTALL_DIR
    chmod -R 750 $INSTALL_DIR
    
    print_success "Directories created"
}

clone_repository() {
    echo "Cloning Otedama repository..."
    
    if [ -d "$INSTALL_DIR/.git" ]; then
        print_warning "Repository already exists, pulling latest..."
        cd $INSTALL_DIR
        sudo -u $USER git pull
    else
        sudo -u $USER git clone https://github.com/otedama/otedama.git $INSTALL_DIR
    fi
    
    print_success "Repository cloned"
}

install_npm_packages() {
    echo "Installing npm packages..."
    
    cd $INSTALL_DIR
    sudo -u $USER npm ci --production
    
    print_success "NPM packages installed"
}

configure_pool() {
    echo "Configuring pool..."
    
    if [ ! -f "$INSTALL_DIR/.env" ]; then
        cp $INSTALL_DIR/.env.example $INSTALL_DIR/.env
        print_warning "Please edit $INSTALL_DIR/.env with your configuration"
    fi
    
    if [ ! -f "$INSTALL_DIR/otedama.config.js" ]; then
        cp $INSTALL_DIR/otedama.config.example.js $INSTALL_DIR/otedama.config.js
        print_warning "Please edit $INSTALL_DIR/otedama.config.js"
    fi
    
    print_success "Configuration files created"
}

install_systemd_services() {
    echo "Installing systemd services..."
    
    cp $INSTALL_DIR/deploy/systemd/*.service /etc/systemd/system/
    cp $INSTALL_DIR/deploy/systemd/*.timer /etc/systemd/system/
    
    systemctl daemon-reload
    systemctl enable otedama.service
    systemctl enable otedama-backup.timer
    
    print_success "Systemd services installed"
}

setup_firewall() {
    echo "Configuring firewall..."
    
    if command -v ufw &> /dev/null; then
        ufw allow 3333/tcp comment "Otedama Stratum"
        ufw allow 3336/tcp comment "Otedama Stratum V2"
        ufw allow 8080/tcp comment "Otedama Dashboard"
        ufw allow 8333/tcp comment "Otedama P2P"
        print_success "UFW firewall rules added"
    elif command -v firewall-cmd &> /dev/null; then
        firewall-cmd --permanent --add-port=3333/tcp
        firewall-cmd --permanent --add-port=3336/tcp
        firewall-cmd --permanent --add-port=8080/tcp
        firewall-cmd --permanent --add-port=8333/tcp
        firewall-cmd --reload
        print_success "Firewalld rules added"
    else
        print_warning "No firewall detected, please configure manually"
    fi
}

generate_admin_key() {
    echo "Generating admin key..."
    
    cd $INSTALL_DIR
    ADMIN_KEY=$(sudo -u $USER node scripts/generate-admin-key.js --save | grep "API Key:" | cut -d' ' -f3)
    
    if [ ! -z "$ADMIN_KEY" ]; then
        echo
        echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
        echo -e "${GREEN}Admin API Key: $ADMIN_KEY${NC}"
        echo -e "${GREEN}Save this key securely!${NC}"
        echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
        echo
    fi
}

setup_bitcoin_node() {
    echo "Checking Bitcoin node..."
    
    if command -v bitcoin-cli &> /dev/null; then
        if bitcoin-cli getblockchaininfo &> /dev/null; then
            print_success "Bitcoin node is running"
        else
            print_warning "Bitcoin node installed but not running"
        fi
    else
        print_warning "Bitcoin node not found. Please install Bitcoin Core for payments"
        echo "Visit: https://bitcoin.org/en/download"
    fi
}

setup_monitoring() {
    echo "Setting up monitoring..."
    
    if command -v docker &> /dev/null && command -v docker-compose &> /dev/null; then
        print_warning "Docker detected. Run 'docker-compose up -d' to start monitoring stack"
    else
        print_warning "Docker not found. Install Docker for full monitoring stack"
    fi
}

print_summary() {
    echo
    echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}    Installation Complete!${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
    echo
    echo "Next steps:"
    echo "1. Edit configuration files:"
    echo "   - $INSTALL_DIR/.env"
    echo "   - $INSTALL_DIR/otedama.config.js"
    echo
    echo "2. Initialize database:"
    echo "   cd $INSTALL_DIR && sudo -u $USER npm run db:setup"
    echo
    echo "3. Start the pool:"
    echo "   systemctl start otedama"
    echo
    echo "4. Check status:"
    echo "   systemctl status otedama"
    echo "   journalctl -u otedama -f"
    echo
    echo "5. Access dashboard:"
    echo "   http://$(hostname -I | awk '{print $1}'):8080"
    echo
    echo "For automation management:"
    echo "   cd $INSTALL_DIR && node scripts/otedama-auto.js"
    echo
}

# Main installation
main() {
    print_header
    
    # Check if running as root
    if [ "$EUID" -ne 0 ]; then 
        print_error "Please run as root (use sudo)"
    fi
    
    # Detect OS
    detect_os
    echo "Detected OS: $OS $VER"
    echo
    
    # Installation steps
    install_dependencies
    install_nodejs
    create_user
    setup_directories
    clone_repository
    install_npm_packages
    configure_pool
    install_systemd_services
    setup_firewall
    setup_bitcoin_node
    generate_admin_key
    setup_monitoring
    
    print_summary
}

# Run main function
main
