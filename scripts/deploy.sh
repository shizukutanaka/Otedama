#!/bin/bash
# Otedama automated deployment script
# Following John Carmack's principle: "Keep it simple and fast"

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_ROOT/build"
DEPLOY_ENV="${1:-production}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

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

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    # Check Go installation
    if ! command -v go &> /dev/null; then
        log_error "Go is not installed"
        exit 1
    fi
    
    # Check minimum Go version
    GO_VERSION=$(go version | awk '{print $3}' | sed 's/go//')
    MIN_VERSION="1.21"
    if [ "$(printf '%s\n' "$MIN_VERSION" "$GO_VERSION" | sort -V | head -n1)" != "$MIN_VERSION" ]; then
        log_error "Go version $GO_VERSION is below minimum required version $MIN_VERSION"
        exit 1
    fi
    
    log_info "Prerequisites check passed"
}

# Build the application
build_application() {
    log_info "Building Otedama for $DEPLOY_ENV..."
    
    cd "$PROJECT_ROOT"
    
    # Clean build directory
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"
    
    # Set build variables
    VERSION=$(git describe --tags --always --dirty 2>/dev/null || echo "dev")
    BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
    
    # Build flags
    LDFLAGS="
        -X main.Version=$VERSION
        -X main.BuildTime=$BUILD_TIME
        -X main.Commit=$COMMIT
        -X main.Environment=$DEPLOY_ENV
    "
    
    # Build for different platforms
    PLATFORMS=("linux/amd64" "linux/arm64" "darwin/amd64" "darwin/arm64" "windows/amd64")
    
    for platform in "${PLATFORMS[@]}"; do
        platform_split=(${platform//\// })
        GOOS=${platform_split[0]}
        GOARCH=${platform_split[1]}
        
        output_name="otedama-${GOOS}-${GOARCH}"
        if [ $GOOS = "windows" ]; then
            output_name="${output_name}.exe"
        fi
        
        log_info "Building for $GOOS/$GOARCH..."
        
        CGO_ENABLED=0 GOOS=$GOOS GOARCH=$GOARCH go build \
            -ldflags "$LDFLAGS" \
            -o "$BUILD_DIR/$output_name" \
            ./cmd/otedama
    done
    
    log_info "Build completed successfully"
}

# Run tests
run_tests() {
    log_info "Running tests..."
    
    cd "$PROJECT_ROOT"
    
    # Run unit tests
    go test -race -coverprofile=coverage.out ./...
    
    # Run integration tests if in staging/production
    if [ "$DEPLOY_ENV" != "dev" ]; then
        log_info "Running integration tests..."
        go test -tags=integration -timeout=10m ./...
    fi
    
    log_info "All tests passed"
}

# Create deployment package
create_package() {
    log_info "Creating deployment package..."
    
    PACKAGE_DIR="$BUILD_DIR/package"
    mkdir -p "$PACKAGE_DIR"
    
    # Copy binaries
    cp "$BUILD_DIR"/otedama-* "$PACKAGE_DIR/"
    
    # Copy configuration templates
    cp -r "$PROJECT_ROOT/configs" "$PACKAGE_DIR/"
    
    # Copy scripts
    cp -r "$PROJECT_ROOT/scripts" "$PACKAGE_DIR/"
    
    # Create systemd service file
    cat > "$PACKAGE_DIR/otedama.service" <<EOF
[Unit]
Description=Otedama P2P Mining Pool
After=network.target

[Service]
Type=simple
User=otedama
Group=otedama
WorkingDirectory=/opt/otedama
ExecStart=/opt/otedama/otedama
Restart=always
RestartSec=10
KillMode=mixed
KillSignal=SIGTERM

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/otedama /var/log/otedama

# Resource limits
LimitNOFILE=65536
LimitNPROC=4096

# Environment
Environment="OTEDAMA_ENV=$DEPLOY_ENV"

[Install]
WantedBy=multi-user.target
EOF
    
    # Create deployment manifest
    cat > "$PACKAGE_DIR/manifest.json" <<EOF
{
    "version": "$VERSION",
    "environment": "$DEPLOY_ENV",
    "build_time": "$BUILD_TIME",
    "commit": "$COMMIT",
    "timestamp": "$TIMESTAMP"
}
EOF
    
    # Create archive
    ARCHIVE_NAME="otedama-${VERSION}-${DEPLOY_ENV}-${TIMESTAMP}.tar.gz"
    cd "$BUILD_DIR"
    tar czf "$ARCHIVE_NAME" package/
    
    log_info "Deployment package created: $ARCHIVE_NAME"
}

# Deploy to servers
deploy_to_servers() {
    log_info "Deploying to $DEPLOY_ENV servers..."
    
    # Read server list from config
    case $DEPLOY_ENV in
        "dev")
            SERVERS=("localhost")
            ;;
        "staging")
            SERVERS=("staging1.otedama.local" "staging2.otedama.local")
            ;;
        "production")
            SERVERS=("prod1.otedama.io" "prod2.otedama.io" "prod3.otedama.io")
            ;;
        *)
            log_error "Unknown environment: $DEPLOY_ENV"
            exit 1
            ;;
    esac
    
    # Deploy to each server
    for server in "${SERVERS[@]}"; do
        log_info "Deploying to $server..."
        
        if [ "$server" = "localhost" ]; then
            # Local deployment
            deploy_local
        else
            # Remote deployment
            deploy_remote "$server"
        fi
    done
    
    log_info "Deployment completed"
}

# Deploy locally
deploy_local() {
    log_info "Performing local deployment..."
    
    # Create directories
    sudo mkdir -p /opt/otedama /var/lib/otedama /var/log/otedama
    
    # Extract package
    sudo tar xzf "$BUILD_DIR/otedama-"*.tar.gz -C /opt/otedama --strip-components=1
    
    # Set permissions
    sudo useradd -r -s /bin/false otedama || true
    sudo chown -R otedama:otedama /opt/otedama /var/lib/otedama /var/log/otedama
    
    # Install service
    sudo cp /opt/otedama/package/otedama.service /etc/systemd/system/
    sudo systemctl daemon-reload
    
    # Start service
    sudo systemctl enable otedama
    sudo systemctl restart otedama
    
    # Verify
    sleep 5
    if sudo systemctl is-active --quiet otedama; then
        log_info "Otedama service is running"
    else
        log_error "Failed to start Otedama service"
        sudo journalctl -u otedama -n 50
        exit 1
    fi
}

# Deploy to remote server
deploy_remote() {
    local server=$1
    log_info "Deploying to remote server: $server"
    
    # Copy package
    scp "$BUILD_DIR/otedama-"*.tar.gz "otedama@$server:/tmp/"
    
    # Execute deployment script
    ssh "otedama@$server" 'bash -s' <<'REMOTE_SCRIPT'
        set -euo pipefail
        
        # Extract package
        sudo tar xzf /tmp/otedama-*.tar.gz -C /opt/otedama --strip-components=1
        
        # Restart service
        sudo systemctl restart otedama
        
        # Cleanup
        rm /tmp/otedama-*.tar.gz
REMOTE_SCRIPT
    
    log_info "Remote deployment completed"
}

# Health check
health_check() {
    log_info "Performing health checks..."
    
    # Wait for service to stabilize
    sleep 10
    
    # Check API endpoint
    if curl -f -s http://localhost:8080/health > /dev/null; then
        log_info "Health check passed"
    else
        log_error "Health check failed"
        exit 1
    fi
}

# Main deployment flow
main() {
    log_info "Starting Otedama deployment"
    log_info "Environment: $DEPLOY_ENV"
    log_info "Timestamp: $TIMESTAMP"
    
    check_prerequisites
    run_tests
    build_application
    create_package
    deploy_to_servers
    health_check
    
    log_info "Deployment completed successfully!"
}

# Run main function
main