#!/bin/bash
# Otedama Light - Production Setup Script

set -e

echo "==================================="
echo "Otedama Light - Production Setup"
echo "==================================="
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
   echo "Please do not run as root"
   exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "Error: Node.js 18+ required (found $(node -v))"
    exit 1
fi

echo "✓ Node.js version check passed"

# Create necessary directories
echo "Creating directories..."
mkdir -p data/{shares,miners,blocks}
mkdir -p logs

echo "✓ Directories created"

# Install dependencies
echo "Installing dependencies..."
npm install --production
echo "✓ Dependencies installed"

# Build TypeScript
echo "Building TypeScript..."
npm run build
echo "✓ Build complete"

# Setup environment file
if [ ! -f .env ]; then
    echo "Setting up environment..."
    cp .env.example .env
    echo ""
    echo "⚠️  Please edit .env file with your configuration"
    echo ""
    read -p "Press enter to open .env in editor..."
    ${EDITOR:-nano} .env
fi

# Create systemd service (if on Linux with systemd)
if command -v systemctl &> /dev/null; then
    echo ""
    read -p "Create systemd service? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        cat > otedama-light.service << EOF
[Unit]
Description=Otedama Light Mining Pool
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$(pwd)
ExecStart=$(which node) dist/main.js
Restart=always
RestartSec=10
StandardOutput=append:$(pwd)/logs/otedama.log
StandardError=append:$(pwd)/logs/otedama-error.log

# Security
NoNewPrivileges=true
PrivateTmp=true

# Resource limits
LimitNOFILE=65536
MemoryLimit=2G

[Install]
WantedBy=multi-user.target
EOF
        
        echo "Service file created: otedama-light.service"
        echo "To install:"
        echo "  sudo cp otedama-light.service /etc/systemd/system/"
        echo "  sudo systemctl daemon-reload"
        echo "  sudo systemctl enable otedama-light"
        echo "  sudo systemctl start otedama-light"
    fi
fi

# Set up log rotation
cat > logrotate.conf << EOF
$(pwd)/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0644 $USER $USER
}
EOF

echo ""
echo "✓ Log rotation config created"

# Final checks
echo ""
echo "==================================="
echo "Setup Complete!"
echo "==================================="
echo ""
echo "Next steps:"
echo "1. Edit .env file if you haven't already"
echo "2. Ensure your Bitcoin node is running and synced"
echo "3. Start the pool:"
echo "   npm start"
echo ""
echo "Or with Docker:"
echo "   docker-compose up -d"
echo ""
echo "Monitor health:"
echo "   ./scripts/monitor.sh"
echo ""
echo "View dashboard:"
echo "   http://localhost:8081"
echo ""
