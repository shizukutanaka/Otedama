#!/bin/bash

# Import Path Fixing Script
# Updates all Go import paths to use the correct module name

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Change to project root
cd "$(dirname "$0")/.."

OLD_MODULE="github.com/otedama/otedama"
NEW_MODULE="github.com/shizukachan/otedama"

log_info "Fixing import paths from $OLD_MODULE to $NEW_MODULE..."

# Find all Go files and update imports
find . -name "*.go" -type f | while read -r file; do
    # Skip vendor and backup directories
    if [[ "$file" == *"/vendor/"* ]] || [[ "$file" == *"_backup"* ]]; then
        continue
    fi
    
    # Check if file contains old import
    if grep -q "$OLD_MODULE" "$file"; then
        log_info "Updating imports in: $file"
        sed -i "s|$OLD_MODULE|$NEW_MODULE|g" "$file"
    fi
done

log_success "Import paths updated!"

# Update go.mod replace directives if any
if grep -q "replace" go.mod; then
    log_info "Updating replace directives in go.mod..."
    sed -i "s|$OLD_MODULE|$NEW_MODULE|g" go.mod
fi

# Run go mod tidy to clean up
log_info "Running go mod tidy..."
go mod tidy || log_error "go mod tidy failed - manual intervention may be needed"

log_success "Import path fixing complete!"