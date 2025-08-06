#!/bin/bash
#
# Otedama Production Deployment Script
# Professional deployment for enterprise environments
#

set -e  # Exit on error
set -u  # Exit on undefined variable
set -o pipefail  # Exit on pipe failure

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
INSTALL_DIR="/opt/otedama"
SERVICE_USER="otedama"
SERVICE_GROUP="otedama"
CONFIG_FILE="/etc/otedama/config.yaml"
LOG_DIR="/var/log/otedama"
DATA_DIR="/var/lib/otedama"
SYSTEMD_SERVICE="/etc/systemd/system/otedama.service"

# Functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "This script must be run as root"
        exit 1
    fi
}

check_dependencies() {
    log_info "Checking dependencies..."
    
    # Check for required commands
    local deps=("go" "git" "systemctl" "curl")
    for dep in "${deps[@]}"; do
        if ! command -v "$dep" &> /dev/null; then
            log_error "$dep is not installed"
            exit 1
        fi
    done
    
    # Check Go version
    local go_version=$(go version | awk '{print $3}' | sed 's/go//')
    local required_version="1.21"
    if [ "$(printf '%s\n' "$required_version" "$go_version" | sort -V | head -n1)" != "$required_version" ]; then
        log_error "Go version $required_version or higher is required (found: $go_version)"
        exit 1
    fi
    
    log_info "All dependencies satisfied"
}

create_user() {
    log_info "Creating service user..."
    
    if id "$SERVICE_USER" &>/dev/null; then
        log_warn "User $SERVICE_USER already exists"
    else
        useradd -r -s /bin/false -d "$DATA_DIR" -c "Otedama Mining Service" "$SERVICE_USER"
        log_info "Created user $SERVICE_USER"
    fi
}

create_directories() {
    log_info "Creating directories..."
    
    # Create directories
    mkdir -p "$INSTALL_DIR"
    mkdir -p "$(dirname "$CONFIG_FILE")"
    mkdir -p "$LOG_DIR"
    mkdir -p "$DATA_DIR"
    
    # Set permissions
    chown -R "$SERVICE_USER:$SERVICE_GROUP" "$LOG_DIR"
    chown -R "$SERVICE_USER:$SERVICE_GROUP" "$DATA_DIR"
    chmod 755 "$INSTALL_DIR"
    chmod 750 "$LOG_DIR"
    chmod 750 "$DATA_DIR"
    
    log_info "Directories created"
}

build_binary() {
    log_info "Building Otedama binary..."
    
    # Build with optimizations
    cd "$(dirname "$0")/.."
    
    CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build \
        -ldflags="-s -w -X main.Version=$(git describe --tags --always)" \
        -trimpath \
        -o "$INSTALL_DIR/otedama" \
        ./cmd/otedama
    
    # Set permissions
    chmod 755 "$INSTALL_DIR/otedama"
    chown root:root "$INSTALL_DIR/otedama"
    
    log_info "Binary built and installed"
}

install_config() {
    log_info "Installing configuration..."
    
    if [ -f "$CONFIG_FILE" ]; then
        log_warn "Configuration file already exists, creating backup..."
        cp "$CONFIG_FILE" "$CONFIG_FILE.backup.$(date +%Y%m%d-%H%M%S)"
    fi
    
    # Copy configuration
    if [ -f "config.yaml" ]; then
        cp config.yaml "$CONFIG_FILE"
    elif [ -f "config.example.yaml" ]; then
        cp config.example.yaml "$CONFIG_FILE"
    else
        log_error "No configuration file found"
        exit 1
    fi
    
    # Set permissions
    chown root:$SERVICE_GROUP "$CONFIG_FILE"
    chmod 640 "$CONFIG_FILE"
    
    log_info "Configuration installed"
}

install_systemd_service() {
    log_info "Installing systemd service..."
    
    cat > "$SYSTEMD_SERVICE" <<EOF
[Unit]
Description=Otedama P2P Mining Pool
Documentation=https://github.com/otedama/otedama
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$DATA_DIR

# Security settings
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR $LOG_DIR

# Resource limits
LimitNOFILE=65536
LimitNPROC=4096

# Environment
Environment="OTEDAMA_CONFIG_PATH=$CONFIG_FILE"
Environment="OTEDAMA_DATA_PATH=$DATA_DIR"
Environment="OTEDAMA_LOG_PATH=$LOG_DIR"

# Start command
ExecStart=$INSTALL_DIR/otedama serve --config $CONFIG_FILE
ExecReload=/bin/kill -USR1 \$MAINPID
ExecStop=/bin/kill -TERM \$MAINPID

# Restart policy
Restart=always
RestartSec=10

# Logging
StandardOutput=append:$LOG_DIR/otedama.log
StandardError=append:$LOG_DIR/otedama-error.log

[Install]
WantedBy=multi-user.target
EOF
    
    # Reload systemd
    systemctl daemon-reload
    
    log_info "Systemd service installed"
}

configure_firewall() {
    log_info "Configuring firewall..."
    
    # Check if firewall is active
    if command -v ufw &> /dev/null; then
        if ufw status | grep -q "Status: active"; then
            log_info "Configuring UFW firewall..."
            ufw allow 3333/tcp comment 'Otedama Stratum'
            ufw allow 8080/tcp comment 'Otedama API'
            ufw allow 9090/tcp comment 'Otedama Metrics'
            ufw allow 4444/tcp comment 'Otedama Federation'
        fi
    elif command -v firewall-cmd &> /dev/null; then
        if systemctl is-active firewalld &> /dev/null; then
            log_info "Configuring firewalld..."
            firewall-cmd --permanent --add-port=3333/tcp
            firewall-cmd --permanent --add-port=8080/tcp
            firewall-cmd --permanent --add-port=9090/tcp
            firewall-cmd --permanent --add-port=4444/tcp
            firewall-cmd --reload
        fi
    else
        log_warn "No firewall detected, skipping firewall configuration"
    fi
}

setup_log_rotation() {
    log_info "Setting up log rotation..."
    
    cat > /etc/logrotate.d/otedama <<EOF
$LOG_DIR/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 640 $SERVICE_USER $SERVICE_GROUP
    sharedscripts
    postrotate
        systemctl reload otedama 2>/dev/null || true
    endscript
}
EOF
    
    log_info "Log rotation configured"
}

optimize_system() {
    log_info "Optimizing system settings..."
    
    # Network optimization
    cat >> /etc/sysctl.d/99-otedama.conf <<EOF
# Otedama Network Optimization
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_keepalive_intvl = 15
net.core.rmem_default = 31457280
net.core.rmem_max = 134217728
net.core.wmem_default = 31457280
net.core.wmem_max = 134217728
net.ipv4.tcp_rmem = 4096 87380 134217728
net.ipv4.tcp_wmem = 4096 65536 134217728
EOF
    
    # Apply settings
    sysctl -p /etc/sysctl.d/99-otedama.conf
    
    # File descriptor limits
    cat >> /etc/security/limits.d/otedama.conf <<EOF
$SERVICE_USER soft nofile 65536
$SERVICE_USER hard nofile 65536
$SERVICE_USER soft nproc 32768
$SERVICE_USER hard nproc 32768
EOF
    
    log_info "System optimized"
}

start_service() {
    log_info "Starting Otedama service..."
    
    systemctl enable otedama
    systemctl start otedama
    
    # Wait for service to start
    sleep 3
    
    if systemctl is-active otedama &> /dev/null; then
        log_info "Otedama service started successfully"
    else
        log_error "Failed to start Otedama service"
        systemctl status otedama
        exit 1
    fi
}

verify_installation() {
    log_info "Verifying installation..."
    
    # Check service status
    if ! systemctl is-active otedama &> /dev/null; then
        log_error "Service is not running"
        return 1
    fi
    
    # Check API endpoint
    if curl -s -f http://localhost:8080/api/health > /dev/null 2>&1; then
        log_info "API endpoint is responding"
    else
        log_warn "API endpoint is not responding yet"
    fi
    
    # Check log files
    if [ -f "$LOG_DIR/otedama.log" ]; then
        log_info "Log file created successfully"
    else
        log_warn "Log file not found"
    fi
    
    log_info "Installation verified"
}

print_summary() {
    echo
    echo "========================================="
    echo "  Otedama Production Deployment Complete"
    echo "========================================="
    echo
    echo "Installation Directory: $INSTALL_DIR"
    echo "Configuration File: $CONFIG_FILE"
    echo "Log Directory: $LOG_DIR"
    echo "Data Directory: $DATA_DIR"
    echo
    echo "Service Management:"
    echo "  Start:   systemctl start otedama"
    echo "  Stop:    systemctl stop otedama"
    echo "  Status:  systemctl status otedama"
    echo "  Logs:    journalctl -u otedama -f"
    echo
    echo "Web Interfaces:"
    echo "  API:     http://localhost:8080"
    echo "  Metrics: http://localhost:9090"
    echo
    echo "Next Steps:"
    echo "  1. Edit configuration: $CONFIG_FILE"
    echo "  2. Restart service: systemctl restart otedama"
    echo "  3. Monitor logs: tail -f $LOG_DIR/otedama.log"
    echo
}

# Main execution
main() {
    log_info "Starting Otedama production deployment..."
    
    check_root
    check_dependencies
    create_user
    create_directories
    build_binary
    install_config
    install_systemd_service
    configure_firewall
    setup_log_rotation
    optimize_system
    start_service
    verify_installation
    print_summary
    
    log_info "Deployment completed successfully!"
}

# Run main function
main "$@"