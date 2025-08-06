#!/bin/bash

# Pre-removal script for Otedama

set -e

# Stop the service if running
if command -v systemctl >/dev/null 2>&1; then
    echo "Stopping otedama service..."
    systemctl stop otedama.service || true
    echo "Disabling otedama service..."
    systemctl disable otedama.service || true
fi

# Backup configuration
if [ -f /etc/otedama/config.yaml ]; then
    echo "Backing up configuration..."
    cp /etc/otedama/config.yaml /etc/otedama/config.yaml.backup.$(date +%Y%m%d_%H%M%S)
fi

echo "Otedama pre-removal tasks completed."