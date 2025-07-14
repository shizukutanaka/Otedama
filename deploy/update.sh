#!/bin/bash

# Otedama Update Script

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
    exit 1
}

print_info() {
    echo -e "${YELLOW}→ $1${NC}"
}

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   print_error "This script must be run as root"
fi

# Check if Otedama is installed
if [ ! -d "/opt/otedama" ]; then
    print_error "Otedama not found in /opt/otedama"
fi

echo "======================================"
echo "       Otedama Update Script          "
echo "======================================"
echo

# Stop service
print_info "Stopping Otedama service..."
systemctl stop otedama || true
print_success "Service stopped"

# Backup current version
print_info "Creating backup..."
BACKUP_DIR="/opt/otedama-backup-$(date +%Y%m%d-%H%M%S)"
cp -r /opt/otedama $BACKUP_DIR
print_success "Backup created at $BACKUP_DIR"

# Update code
print_info "Updating Otedama..."
cd /opt/otedama

# Pull latest changes
git fetch --all
git reset --hard origin/main
print_success "Code updated"

# Update dependencies
print_info "Updating dependencies..."
npm ci --only=production
print_success "Dependencies updated"

# Build
print_info "Building..."
npm run build
print_success "Build complete"

# Fix permissions
chown -R otedama:otedama /opt/otedama
print_success "Permissions updated"

# Restart service
print_info "Starting Otedama service..."
systemctl start otedama
print_success "Service started"

# Check status
sleep 2
if systemctl is-active --quiet otedama; then
    print_success "Otedama is running"
else
    print_error "Otedama failed to start. Check logs: journalctl -u otedama -f"
fi

echo
echo "======================================"
print_success "Update complete!"
echo "Old version backed up to: $BACKUP_DIR"
echo "======================================"
