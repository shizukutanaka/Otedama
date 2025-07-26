# Otedama Quick Setup Guide

## 🚀 One-Click Setup & Start

### Windows
```cmd
# Setup (first time only)
setup.cmd

# Start the pool
start.cmd
```

### Linux/macOS
```bash
# Setup (first time only)
chmod +x setup.sh
./setup.sh

# Start the pool
./start.sh
```

### Universal (All Platforms)
```bash
# Setup
node setup.js

# Start
node start.js
```

## 📋 What the Setup Does

1. **System Check**
   - Verifies Node.js 18+ and npm 8+
   - Checks available memory and disk space
   - Detects build tools for native modules

2. **Dependency Installation**
   - Installs all required npm packages
   - Compiles native modules if needed

3. **Configuration**
   - Interactive configuration wizard
   - Sets up pool parameters (name, algorithm, fees)
   - Configures network ports
   - Enables security features (ZKP, SSL)

4. **Database Setup**
   - Creates SQLite database
   - Initializes tables and indexes

5. **SSL Certificates** (optional)
   - Generates self-signed certificates
   - Enables secure connections

6. **System Optimization**
   - Applies OS-specific performance tweaks
   - Configures network parameters

7. **Service Installation** (optional)
   - Windows: Creates Windows service
   - Linux: Creates systemd service
   - macOS: Creates launchd plist

## 🎯 Start Modes

### Auto-Detection
The start script automatically selects the best mode based on your system:
- **Ultra Mode**: 16+ CPUs, 32GB+ RAM
- **Enterprise Mode**: 8+ CPUs, 16GB+ RAM
- **Standard Mode**: All other systems

### Manual Selection
```bash
# Ultra performance mode
node start.js --ultra

# Enterprise mode
node start.js --enterprise

# Development mode
node start.js --dev
```

## 🔧 Configuration Options

### Basic Configuration
- **Pool Name**: Your mining pool's display name
- **Algorithm**: sha256, scrypt, ethash, randomx, kawpow
- **Coin**: BTC, LTC, ETH, XMR, RVN
- **Pool Fee**: 0-5% (default: 1%)
- **Min Payout**: Minimum payout threshold

### Network Configuration
- **Stratum Port**: Mining connection port (default: 3333)
- **API Port**: REST API port (default: 8081)
- **Dashboard Port**: Web dashboard port (default: 8082)

### Security Options
- **ZKP Authentication**: Zero-knowledge proof (no KYC)
- **SSL/TLS**: Encrypted connections

### Advanced Options
- **Max Connections**: Up to 10 million
- **Target Latency**: Performance target in ms
- **Worker Processes**: CPU cores to use
- **Enterprise Mode**: Multi-region, auto-scaling

## 📊 After Setup

### Connect Miners
```
stratum+tcp://your-server:3333
Username: YOUR_WALLET_ADDRESS
Password: x
```

### View Dashboard
Open in browser: `http://localhost:8082`

### API Access
REST API: `http://localhost:8081/api/v1`

### Check Status
```bash
# View logs
node start.js --dev

# Run benchmarks
npm run benchmark

# Health check
npm run health
```

## 🆘 Troubleshooting

### Setup Issues
- **Permission denied**: Run as administrator/sudo
- **Port in use**: Change ports in configuration
- **Dependencies fail**: Install build tools

### Start Issues
- **Config not found**: Run setup first
- **Database locked**: Stop other instances
- **Performance issues**: Try different mode

### Common Commands
```bash
# Reconfigure
node setup.js

# Reset database
rm -rf data/otedama.db
node setup.js

# Update dependencies
npm update

# Check system
npm run health:full
```

## 🔐 Security Notes

- First run generates unique keys
- ZKP provides privacy without KYC
- SSL certificates are self-signed by default
- Change default passwords in production

## 📈 Performance Tips

- Use SSD for database storage
- Allocate sufficient RAM
- Enable huge pages on Linux
- Use enterprise mode for large deployments
- Monitor with Prometheus/Grafana

## 🌍 Multi-Region Setup

For enterprise deployments across regions:
1. Run setup on each server
2. Configure same pool parameters
3. Use different ports if needed
4. Enable enterprise mode
5. Set up load balancer

---

Need help? Check the full documentation:
- [README.md](README.md) - Complete guide
- [docs/API.md](docs/API.md) - API reference
- [CHANGELOG.md](CHANGELOG.md) - Version history

GitHub: https://github.com/shizukutanaka/Otedama