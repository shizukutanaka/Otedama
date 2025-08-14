#!/bin/bash
# Otedama National-Scale Mining Infrastructure Installation Script
# Zero-touch deployment with comprehensive automation and optimization

set -euo pipefail

# Configuration
readonly SCRIPT_NAME="otedama-install"
readonly VERSION="production"
readonly LOG_FILE="/var/log/otedama-install.log"
readonly CONFIG_DIR="/etc/otedama"
readonly DATA_DIR="/var/lib/otedama"

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m' # No Color

# Logging function
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Error handling
error_exit() {
    echo -e "${RED}ERROR: $1${NC}" >&2
    log "ERROR: $1"
    exit 1
}

# Success message
success() {
    echo -e "${GREEN}SUCCESS: $1${NC}"
    log "SUCCESS: $1"
}

# Warning message
warning() {
    echo -e "${YELLOW}WARNING: $1${NC}"
    log "WARNING: $1"
}

# Info message
info() {
    echo -e "${BLUE}INFO: $1${NC}"
    log "INFO: $1"
}

# Detect OS and architecture
detect_environment() {
    local os=$(uname -s)
    local arch=$(uname -m)
    
    case "$os" in
        Linux*)
            OS="linux"
            ;;
        Darwin*)
            OS="darwin"
            ;;
        CYGWIN*|MINGW*|MSYS*)
            OS="windows"
            ;;
        *)
            error_exit "Unsupported operating system: $os"
            ;;
    esac
    
    case "$arch" in
        x86_64)
            ARCH="amd64"
            ;;
        aarch64|arm64)
            ARCH="arm64"
            ;;
        *)
            error_exit "Unsupported architecture: $arch"
            ;;
    esac
    
    info "Detected environment: $OS/$ARCH"
}

# Check system requirements
check_requirements() {
    info "Checking system requirements..."
    
    # Check minimum RAM (2GB)
    local total_ram=$(free -m | awk 'NR==2{print $2}')
    if [[ $total_ram -lt 2048 ]]; then
        warning "Low memory detected: ${total_ram}MB (minimum 2048MB recommended)"
    fi
    
    # Check disk space (10GB)
    local available_space=$(df -m / | awk 'NR==2{print $4}')
    if [[ $available_space -lt 10240 ]]; then
        error_exit "Insufficient disk space: ${available_space}MB (minimum 10240MB required)"
    fi
    
    # Check network connectivity
    if ! ping -c 1 google.com &> /dev/null; then
        error_exit "Network connectivity check failed"
    fi
    
    success "System requirements check passed"
}

# Install dependencies
install_dependencies() {
    info "Installing dependencies..."
    
    case "$OS" in
        linux)
            if command -v apt-get &> /dev/null; then
                sudo apt-get update -qq
                sudo apt-get install -y curl wget git build-essential
            elif command -v yum &> /dev/null; then
                sudo yum install -y curl wget git gcc gcc-c++ make
            elif command -v dnf &> /dev/null; then
                sudo dnf install -y curl wget git gcc gcc-c++ make
            else
                error_exit "Unsupported Linux distribution"
            fi
            ;;
        darwin)
            if ! command -v brew &> /dev/null; then
                /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            fi
            brew install curl wget git
            ;;
        windows)
            # Windows dependencies handled by PowerShell script
            powershell -ExecutionPolicy Bypass -File "./scripts/install.ps1"
            return
            ;;
    esac
    
    success "Dependencies installed successfully"
}

# Download and install Otedama
install_otedama() {
    info "Installing Otedama..."
    
    local download_url="https://github.com/shizukutanaka/Otedama/releases/latest/download/otedama-${OS}-${ARCH}"
    local binary_path="/usr/local/bin/otedama"
    
    # Download binary
    if ! curl -fsSL "$download_url" -o "$binary_path"; then
        error_exit "Failed to download Otedama binary"
    fi
    
    # Make executable
    chmod +x "$binary_path"
    
    # Create symbolic link
    ln -sf "$binary_path" /usr/local/bin/otedama
    
    success "Otedama installed successfully"
}

# Create directory structure
create_directories() {
    info "Creating directory structure..."
    
    mkdir -p "$CONFIG_DIR"
    mkdir -p "$DATA_DIR"
    mkdir -p "$DATA_DIR/logs"
    mkdir -p "$DATA_DIR/backups"
    mkdir -p "$DATA_DIR/database"
    
    # Set proper permissions
    chmod 750 "$CONFIG_DIR"
    chmod 750 "$DATA_DIR"
    chmod 750 "$DATA_DIR/logs"
    chmod 750 "$DATA_DIR/backups"
    chmod 750 "$DATA_DIR/database"
    
    success "Directory structure created"
}

# Generate configuration file
generate_config() {
    info "Generating configuration file..."
    
    local config_file="$CONFIG_DIR/production.yaml"
    
    cat > "$config_file" << 'EOF'
# Otedama Production Configuration
mining:
  algorithm: "sha256d"
  max_devices: 10000
  auto_scale: true
  redundancy: 3

security:
  encryption: "AES-256-GCM"
  authentication: "HSM-based"
  compliance: "FIPS-140-2"

monitoring:
  prometheus: true
  grafana: true
  alerting: true

performance:
  latency: "<50ms"
  throughput: "1 PH/s+"
  uptime: "99.99%"

logging:
  level: "info"
  format: "json"
  output: "file"

network:
  port: 8080
  ssl: true
  compression: true

database:
  type: "sqlite"
  path: "/var/lib/otedama/database/otedama.db"
  backup: true
  encryption: true
EOF
    
    success "Configuration file generated"
}

# Create systemd service
create_systemd_service() {
    info "Creating systemd service..."
    
    local service_file="/etc/systemd/system/otedama.service"
    
    cat > "$service_file" << 'EOF'
[Unit]
Description=Otedama Mining Infrastructure
After=network.target
Wants=network.target

[Service]
Type=simple
User=otedama
Group=otedama
ExecStart=/usr/local/bin/otedama --config /etc/otedama/production.yaml
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

# Security settings
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/otedama

# Resource limits
LimitNOFILE=65536
LimitNPROC=32768

[Install]
WantedBy=multi-user.target
EOF
    
    # Reload systemd
    systemctl daemon-reload
    
    success "Systemd service created"
}

# Create user and group
create_user() {
    info "Creating user and group..."
    
    if ! id -u otedama &> /dev/null; then
        sudo useradd -r -s /bin/false -d "$DATA_DIR" otedama
    fi
    
    # Set ownership
    chown -R otedama:otedama "$DATA_DIR"
    chown -R otedama:otedama "$CONFIG_DIR"
    
    success "User and group created"
}

# Install monitoring stack
install_monitoring() {
    info "Installing monitoring stack..."
    
    # Install Prometheus
    if ! command -v prometheus &> /dev/null; then
        local prometheus_version="2.45.0"
        curl -fsSL "https://github.com/prometheus/prometheus/releases/download/v${prometheus_version}/prometheus-${prometheus_version}.${OS}-${ARCH}.tar.gz" | tar -xz
        sudo cp prometheus-${prometheus_version}.${OS}-${ARCH}/prometheus /usr/local/bin/
        sudo cp prometheus-${prometheus_version}.${OS}-${ARCH}/promtool /usr/local/bin/
    fi
    
    # Install Grafana
    if ! command -v grafana-server &> /dev/null; then
        case "$OS" in
            linux)
                if command -v apt-get &> /dev/null; then
                    sudo apt-get install -y software-properties-common
                    sudo add-apt-repository "deb https://packages.grafana.com/oss/deb stable main"
                    sudo apt-get update
                    sudo apt-get install -y grafana
                elif command -v yum &> /dev/null; then
                    sudo yum install -y https://dl.grafana.com/oss/release/grafana-9.5.2-1.x86_64.rpm
                fi
                ;;
            darwin)
                brew install grafana
                ;;
        esac
    fi
    
    success "Monitoring stack installed"
}

# Configure firewall
configure_firewall() {
    info "Configuring firewall..."
    
    case "$OS" in
        linux)
            if command -v ufw &> /dev/null; then
                sudo ufw allow 8080/tcp
                sudo ufw allow 8081/tcp
                sudo ufw allow 9090/tcp  # Prometheus
                sudo ufw allow 3000/tcp  # Grafana
            elif command -v firewall-cmd &> /dev/null; then
                sudo firewall-cmd --permanent --add-port=8080/tcp
                sudo firewall-cmd --permanent --add-port=8081/tcp
                sudo firewall-cmd --permanent --add-port=9090/tcp
                sudo firewall-cmd --permanent --add-port=3000/tcp
                sudo firewall-cmd --reload
            fi
            ;;
    esac
    
    success "Firewall configured"
}

# Start services
start_services() {
    info "Starting services..."
    
    # Enable and start Otedama
    systemctl enable otedama
    systemctl start otedama
    
    # Enable and start monitoring
    systemctl enable prometheus
    systemctl start prometheus
    
    systemctl enable grafana-server
    systemctl start grafana-server
    
    success "Services started successfully"
}

# Verify installation
verify_installation() {
    info "Verifying installation..."
    
    # Check service status
    if ! systemctl is-active --quiet otedama; then
        error_exit "Otedama service is not running"
    fi
    
    # Check port availability
    if ! nc -z localhost 8080 &> /dev/null; then
        error_exit "Port 8080 is not accessible"
    fi
    
    # Check API endpoint
    if ! curl -fsSL http://localhost:8080/health &> /dev/null; then
        error_exit "Health endpoint is not responding"
    fi
    
    success "Installation verified successfully"
}

# Display installation summary
display_summary() {
    echo ""
    echo -e "${GREEN}============================================${NC}"
    echo -e "${GREEN}Otedama Installation Complete${NC}"
    echo -e "${GREEN}============================================${NC}"
    echo ""
    echo -e "${BLUE}Configuration:${NC} $CONFIG_DIR/production.yaml"
    echo -e "${BLUE}Data Directory:${NC} $DATA_DIR"
    echo -e "${BLUE}Logs:${NC} $DATA_DIR/logs"
    echo -e "${BLUE}Service:${NC} systemctl status otedama"
    echo ""
    echo -e "${BLUE}Web Interface:${NC} http://localhost:8080"
    echo -e "${BLUE}API:${NC} http://localhost:8080/api"
    echo -e "${BLUE}Health:${NC} http://localhost:8080/health"
    echo -e "${BLUE}Metrics:${NC} http://localhost:8080/metrics"
    echo ""
    echo -e "${GREEN}National-scale mining infrastructure is ready for operation${NC}"
    echo ""
}

# Main installation function
main() {
    log "Starting Otedama installation..."
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --mode)
                MODE="$2"
                shift 2
                ;;
            --region)
                REGION="$2"
                shift 2
                ;;
            --help)
                echo "Usage: $0 [--mode production|development] [--region primary|secondary]"
                exit 0
                ;;
            *)
                error_exit "Unknown option: $1"
                ;;
        esac
    done
    
    # Set defaults
    MODE=${MODE:-production}
    REGION=${REGION:-primary}
    
    # Create log directory
    mkdir -p "$(dirname "$LOG_FILE")"
    
    # Installation steps
    detect_environment
    check_requirements
    install_dependencies
    create_directories
    create_user
    install_otedama
    generate_config
    create_systemd_service
    install_monitoring
    configure_firewall
    start_services
    verify_installation
    display_summary
    
    log "Otedama installation completed successfully"
}

# Execute main function
main "$@"
