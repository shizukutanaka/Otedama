#!/bin/bash

# Post-installation script for Otedama

set -e

# Create otedama user if it doesn't exist
if ! id -u otedama >/dev/null 2>&1; then
    echo "Creating otedama user..."
    useradd -r -s /bin/false -d /var/lib/otedama -m otedama
fi

# Create directories
echo "Creating directories..."
mkdir -p /var/log/otedama
mkdir -p /var/lib/otedama
mkdir -p /etc/otedama

# Set permissions
echo "Setting permissions..."
chown -R otedama:otedama /var/log/otedama
chown -R otedama:otedama /var/lib/otedama
chown -R otedama:otedama /etc/otedama

# Set executable permissions
chmod +x /usr/bin/otedama

# Reload systemd
if command -v systemctl >/dev/null 2>&1; then
    echo "Reloading systemd..."
    systemctl daemon-reload
    echo "Enabling otedama service..."
    systemctl enable otedama.service
fi

echo "Otedama installation completed!"
echo "To start the service, run: systemctl start otedama"
echo "To check status, run: systemctl status otedama"
echo "Configuration file: /etc/otedama/config.yaml"
echo "Logs: /var/log/otedama/"