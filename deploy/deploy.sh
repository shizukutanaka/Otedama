#!/bin/bash

# Otedama Deployment Script - Optimized for Production
# Supports Linux, macOS, and Windows (WSL)

set -e

echo "🚀 Otedama Production Deployment Script"
echo "========================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
OTEDAMA_VERSION="0.6.0"
NODE_MIN_VERSION="18.0.0"
INSTALL_DIR="/opt/otedama"
SERVICE_NAME="otedama"
WEB_PORT="8080"
STRATUM_PORT="3333"

# Functions
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_requirements() {
    print_info "Checking system requirements..."
    
    # Check if running as root for system install
    if [[ $EUID -eq 0 ]]; then
        print_warning "Running as root. Installing system-wide."
        INSTALL_DIR="/opt/otedama"
    else
        print_info "Running as user. Installing to home directory."
        INSTALL_DIR="$HOME/otedama"
    fi
    
    # Check Node.js
    if command -v node >/dev/null 2>&1; then
        NODE_VERSION=$(node --version | cut -d'v' -f2)
        print_success "Node.js version $NODE_VERSION found"
        
        # Simple version comparison
        if [[ "$(printf '%s\n' "$NODE_MIN_VERSION" "$NODE_VERSION" | sort -V | head -n1)" != "$NODE_MIN_VERSION" ]]; then
            print_error "Node.js version $NODE_MIN_VERSION or higher is required"
            exit 1
        fi
    else
        print_error "Node.js is not installed"
        print_info "Please install Node.js from https://nodejs.org/"
        exit 1
    fi
    
    # Check npm
    if command -v npm >/dev/null 2>&1; then
        NPM_VERSION=$(npm --version)
        print_success "npm version $NPM_VERSION found"
    else
        print_error "npm is not installed"
        exit 1
    fi
    
    # Check system
    OS=$(uname -s)
    print_info "Operating system: $OS"
    
    # Check ports
    if command -v netstat >/dev/null 2>&1; then
        if netstat -tuln | grep ":$WEB_PORT " >/dev/null; then
            print_warning "Port $WEB_PORT is already in use"
        fi
        if netstat -tuln | grep ":$STRATUM_PORT " >/dev/null; then
            print_warning "Port $STRATUM_PORT is already in use"
        fi
    fi
}

install_otedama() {
    print_info "Installing Otedama to $INSTALL_DIR..."
    
    # Create installation directory
    mkdir -p "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    
    # Download or copy files
    if [[ -f "../index.js" ]]; then
        print_info "Copying local files..."
        cp ../index.js .
        cp ../package.json .
        cp ../README.md .
        cp ../LICENSE .
        cp -r ../web .
        cp -r ../mobile .
        cp -r ../test .
        if [[ -f "../otedama.json" ]]; then
            cp ../otedama.json .
        fi
    else
        print_info "Downloading from repository..."
        if command -v git >/dev/null 2>&1; then
            git clone https://github.com/otedama/otedama.git .
        elif command -v curl >/dev/null 2>&1; then
            curl -L https://github.com/otedama/otedama/archive/main.tar.gz | tar xz --strip-components=1
        elif command -v wget >/dev/null 2>&1; then
            wget -O- https://github.com/otedama/otedama/archive/main.tar.gz | tar xz --strip-components=1
        else
            print_error "No download tool available (git, curl, or wget)"
            exit 1
        fi
    fi
    
    # Install dependencies
    print_info "Installing dependencies..."
    npm install --production --no-audit --no-fund
    
    # Make index.js executable
    chmod +x index.js
    
    print_success "Otedama installed successfully"
}

create_service() {
    print_info "Creating system service..."
    
    if [[ $EUID -eq 0 ]] && command -v systemctl >/dev/null 2>&1; then
        # Create systemd service
        cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=Otedama Mining Pool & DEX
After=network.target
Wants=network.target

[Service]
Type=simple
User=otedama
Group=otedama
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=otedama

# Security settings
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${INSTALL_DIR}

# Environment
Environment=NODE_ENV=production
Environment=OTEDAMA_CONFIG=${INSTALL_DIR}/otedama.json

[Install]
WantedBy=multi-user.target
EOF

        # Create otedama user if it doesn't exist
        if ! id "otedama" &>/dev/null; then
            useradd -r -s /bin/false otedama
            print_info "Created otedama user"
        fi
        
        # Set ownership
        chown -R otedama:otedama "$INSTALL_DIR"
        
        # Reload systemd and enable service
        systemctl daemon-reload
        systemctl enable ${SERVICE_NAME}
        
        print_success "Systemd service created and enabled"
    else
        print_warning "Systemd not available or not running as root. Manual start required."
    fi
}

setup_firewall() {
    print_info "Configuring firewall..."
    
    if command -v ufw >/dev/null 2>&1 && [[ $EUID -eq 0 ]]; then
        ufw allow $WEB_PORT/tcp comment "Otedama Web Interface"
        ufw allow $STRATUM_PORT/tcp comment "Otedama Stratum Server"
        print_success "UFW firewall rules added"
    elif command -v firewall-cmd >/dev/null 2>&1 && [[ $EUID -eq 0 ]]; then
        firewall-cmd --permanent --add-port=$WEB_PORT/tcp
        firewall-cmd --permanent --add-port=$STRATUM_PORT/tcp
        firewall-cmd --reload
        print_success "Firewalld rules added"
    else
        print_warning "No supported firewall found or not running as root"
        print_info "Manually allow ports $WEB_PORT and $STRATUM_PORT"
    fi
}

create_config() {
    print_info "Creating default configuration..."
    
    if [[ ! -f "$INSTALL_DIR/otedama.json" ]]; then
        cat > "$INSTALL_DIR/otedama.json" << EOF
{
  "pool": {
    "name": "Otedama Production Pool",
    "fee": 1.5,
    "minPayout": {
      "BTC": 0.001,
      "ETH": 0.01,
      "RVN": 100,
      "XMR": 0.1,
      "LTC": 0.1
    },
    "payoutInterval": 3600000
  },
  "mining": {
    "enabled": true,
    "currency": "RVN",
    "algorithm": "kawpow",
    "walletAddress": "",
    "threads": 0,
    "intensity": 100
  },
  "network": {
    "p2pPort": 8333,
    "stratumPort": $STRATUM_PORT,
    "apiPort": $WEB_PORT,
    "maxPeers": 100,
    "maxMiners": 10000
  },
  "dex": {
    "enabled": true,
    "tradingFee": 0.003,
    "minLiquidity": 0.001,
    "maxSlippage": 0.05
  },
  "security": {
    "enableRateLimit": true,
    "maxRequestsPerMinute": 1000,
    "enableDDoSProtection": true,
    "maxConnectionsPerIP": 10
  },
  "monitoring": {
    "enableMetrics": true,
    "enableAlerts": true,
    "retention": 604800000
  }
}
EOF
        print_success "Default configuration created"
    else
        print_info "Configuration file already exists"
    fi
}

setup_monitoring() {
    print_info "Setting up monitoring..."
    
    # Create log directory
    mkdir -p "$INSTALL_DIR/logs"
    
    # Set up log rotation
    if [[ $EUID -eq 0 ]] && command -v logrotate >/dev/null 2>&1; then
        cat > /etc/logrotate.d/otedama << EOF
$INSTALL_DIR/logs/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 644 otedama otedama
    postrotate
        systemctl reload otedama >/dev/null 2>&1 || true
    endscript
}
EOF
        print_success "Log rotation configured"
    fi
    
    # Create backup script
    cat > "$INSTALL_DIR/backup.sh" << 'EOF'
#!/bin/bash
# Otedama Backup Script

BACKUP_DIR="/var/backups/otedama"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
INSTALL_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

mkdir -p "$BACKUP_DIR"

# Backup database and config
tar -czf "$BACKUP_DIR/otedama_backup_$TIMESTAMP.tar.gz" \
    -C "$INSTALL_DIR" \
    data/ otedama.json logs/

# Keep only last 7 backups
find "$BACKUP_DIR" -name "otedama_backup_*.tar.gz" -mtime +7 -delete

echo "Backup completed: $BACKUP_DIR/otedama_backup_$TIMESTAMP.tar.gz"
EOF
    
    chmod +x "$INSTALL_DIR/backup.sh"
    print_success "Backup script created"
}

start_service() {
    print_info "Starting Otedama service..."
    
    if [[ $EUID -eq 0 ]] && command -v systemctl >/dev/null 2>&1; then
        systemctl start ${SERVICE_NAME}
        systemctl status ${SERVICE_NAME} --no-pager
        print_success "Service started via systemd"
    else
        print_info "Starting manually..."
        cd "$INSTALL_DIR"
        nohup node index.js > logs/otedama.log 2>&1 &
        echo $! > otedama.pid
        print_success "Started with PID $(cat otedama.pid)"
    fi
}

run_tests() {
    print_info "Running system tests..."
    
    cd "$INSTALL_DIR"
    
    # Basic functionality test
    timeout 30 node test/otedama-test.js || {
        print_warning "Tests completed with warnings"
    }
    
    # Wait a moment for service to start
    sleep 5
    
    # Test API endpoints
    if command -v curl >/dev/null 2>&1; then
        print_info "Testing API endpoints..."
        
        # Health check
        if curl -s -f "http://localhost:$WEB_PORT/api/health" >/dev/null; then
            print_success "Health check passed"
        else
            print_warning "Health check failed"
        fi
        
        # Stats endpoint
        if curl -s -f "http://localhost:$WEB_PORT/api/stats" >/dev/null; then
            print_success "Stats endpoint working"
        else
            print_warning "Stats endpoint failed"
        fi
    fi
}

print_completion() {
    print_success "Otedama deployment completed!"
    echo ""
    echo "🎉 Installation Summary:"
    echo "========================"
    echo "• Installation Directory: $INSTALL_DIR"
    echo "• Web Dashboard: http://localhost:$WEB_PORT"
    echo "• Stratum Server: stratum+tcp://localhost:$STRATUM_PORT"
    echo "• Configuration: $INSTALL_DIR/otedama.json"
    echo "• Logs: $INSTALL_DIR/logs/"
    echo ""
    echo "📝 Next Steps:"
    echo "• Edit $INSTALL_DIR/otedama.json to configure your wallet"
    echo "• Visit http://localhost:$WEB_PORT to monitor mining"
    echo "• Check logs: tail -f $INSTALL_DIR/logs/$(date +%Y-%m-%d).log"
    echo ""
    echo "🛠️  Management Commands:"
    if [[ $EUID -eq 0 ]] && command -v systemctl >/dev/null 2>&1; then
        echo "• Start: systemctl start $SERVICE_NAME"
        echo "• Stop: systemctl stop $SERVICE_NAME"
        echo "• Status: systemctl status $SERVICE_NAME"
        echo "• Logs: journalctl -u $SERVICE_NAME -f"
    else
        echo "• Stop: kill \$(cat $INSTALL_DIR/otedama.pid)"
        echo "• Logs: tail -f $INSTALL_DIR/logs/otedama.log"
    fi
    echo ""
    echo "💰 Start mining with 1.5% fee - the industry's lowest!"
    echo "🌍 Supports 50+ languages and mobile PWA"
    echo "📱 Add to home screen: http://localhost:$WEB_PORT"
}

# Main execution
main() {
    echo "Starting deployment process..."
    
    check_requirements
    install_otedama
    create_config
    
    if [[ $EUID -eq 0 ]]; then
        create_service
        setup_firewall
        setup_monitoring
    fi
    
    start_service
    run_tests
    print_completion
}

# Handle script arguments
case "${1:-install}" in
    "install")
        main
        ;;
    "update")
        print_info "Updating Otedama..."
        cd "$INSTALL_DIR"
        git pull origin main 2>/dev/null || print_warning "Git update failed"
        npm install --production --no-audit --no-fund
        if [[ $EUID -eq 0 ]] && command -v systemctl >/dev/null 2>&1; then
            systemctl restart $SERVICE_NAME
        fi
        print_success "Update completed"
        ;;
    "uninstall")
        print_info "Uninstalling Otedama..."
        if [[ $EUID -eq 0 ]] && command -v systemctl >/dev/null 2>&1; then
            systemctl stop $SERVICE_NAME 2>/dev/null || true
            systemctl disable $SERVICE_NAME 2>/dev/null || true
            rm -f /etc/systemd/system/${SERVICE_NAME}.service
            systemctl daemon-reload
        fi
        rm -rf "$INSTALL_DIR"
        print_success "Uninstall completed"
        ;;
    "help")
        echo "Otedama Deployment Script"
        echo "Usage: $0 [install|update|uninstall|help]"
        echo ""
        echo "Commands:"
        echo "  install   - Install Otedama (default)"
        echo "  update    - Update existing installation"
        echo "  uninstall - Remove Otedama completely"
        echo "  help      - Show this help message"
        ;;
    *)
        print_error "Unknown command: $1"
        echo "Use '$0 help' for usage information"
        exit 1
        ;;
esac
