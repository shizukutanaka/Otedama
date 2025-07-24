# Otedama Installation Guide

## 📋 System Requirements

### Minimum Requirements
- **OS**: Windows 10+, Ubuntu 18.04+, macOS 10.14+
- **Node.js**: v18.0.0 or higher
- **RAM**: 4GB (8GB recommended)
- **Storage**: 10GB free space (SSD recommended)
- **Network**: Stable internet connection

### For Mining
- **CPU**: 2+ cores (4+ recommended)
- **GPU**: NVIDIA/AMD with 4GB+ VRAM (optional)
- **Drivers**: Latest GPU drivers installed

## 🚀 Quick Install

### Option 1: NPM (Recommended)
```bash
# Install globally
npm install -g otedama

# Verify installation
otedama --version
```

### Option 2: From Source
```bash
# Clone repository
git clone https://github.com/otedama/otedama.git
cd otedama

# Install dependencies
npm install

# Link globally
npm link

# Verify installation
otedama --version
```

## 🖥️ Platform-Specific Instructions

### Windows

1. **Install Node.js**
   - Download from [nodejs.org](https://nodejs.org/)
   - Choose LTS version
   - Run installer with default settings

2. **Install Otedama**
   ```cmd
   npm install -g otedama
   ```

3. **Install Visual C++ Build Tools** (for native modules)
   ```cmd
   npm install -g windows-build-tools
   ```

### Linux (Ubuntu/Debian)

1. **Install Node.js**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

2. **Install build essentials**
   ```bash
   sudo apt-get install -y build-essential
   ```

3. **Install Otedama**
   ```bash
   npm install -g otedama
   ```

### macOS

1. **Install Homebrew** (if not installed)
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```

2. **Install Node.js**
   ```bash
   brew install node
   ```

3. **Install Otedama**
   ```bash
   npm install -g otedama
   ```

## ⛏️ Miner Setup

### 1. Configure BTC Address
```bash
otedama-miner config
```
- Select "Set BTC Address"
- Enter your Bitcoin wallet address

### 2. Configure Hardware
```bash
otedama-miner config
```
- Select "Hardware Settings"
- Choose CPU/GPU options
- Set thread counts

### 3. Start Mining
```bash
# Basic start
otedama-miner start

# Start with idle mining
otedama-miner start --idle

# Start minimized
otedama-miner start --minimized
```

## 🏊 Pool Setup

### 1. Run Setup Wizard
```bash
otedama start --wizard
```

### 2. Configure Pool
Follow the interactive prompts:
- Pool name
- Fee percentage
- Network mode
- Security settings

### 3. Start Pool
```bash
otedama start
```

## 🐳 Docker Installation

### Using Docker Compose
```bash
# Download docker-compose.yml
curl -O https://raw.githubusercontent.com/otedama/otedama/main/docker-compose.yml

# Start services
docker-compose up -d
```

### Using Docker Run
```bash
docker run -d \
  -p 3333:3333 \
  -p 3000:3000 \
  -v otedama-data:/data \
  otedama/pool:latest
```

## 🔧 Post-Installation

### Verify Installation
```bash
# Check version
otedama --version

# Run health check
otedama health-check

# View available commands
otedama --help
```

### Configure Firewall

#### Windows
```powershell
# Allow Stratum port
New-NetFirewallRule -DisplayName "Otedama Stratum" -Direction Inbound -LocalPort 3333 -Protocol TCP -Action Allow

# Allow Web UI
New-NetFirewallRule -DisplayName "Otedama Web" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

#### Linux
```bash
# Using ufw
sudo ufw allow 3333/tcp
sudo ufw allow 3000/tcp
```

### Enable Auto-start

#### Windows
```bash
# Add to startup
otedama-miner config
# Enable "Start on Boot"
```

#### Linux (systemd)
```bash
# Create service file
sudo nano /etc/systemd/system/otedama.service

# Add content:
[Unit]
Description=Otedama Mining Pool
After=network.target

[Service]
Type=simple
User=your-user
ExecStart=/usr/bin/otedama start
Restart=always

[Install]
WantedBy=multi-user.target

# Enable service
sudo systemctl enable otedama
sudo systemctl start otedama
```

## 🆘 Troubleshooting

### Installation Fails

**Node.js version issue**
```bash
# Check version
node --version

# Update if needed
npm install -g n
n latest
```

**Permission errors**
```bash
# Linux/macOS
sudo npm install -g otedama

# Windows (run as Administrator)
npm install -g otedama
```

### Can't Find Command

**Add to PATH**
```bash
# Find npm global directory
npm config get prefix

# Add to PATH
export PATH=$PATH:$(npm config get prefix)/bin
```

### Native Module Errors

**Rebuild native modules**
```bash
cd $(npm root -g)/otedama
npm rebuild
```

## 📚 Next Steps

- Read the [Getting Started Guide](docs/GETTING_STARTED.md)
- Configure your miner with [Miner Guide](docs/MINER_GUIDE.md)
- Set up a pool with [Pool Setup Guide](docs/POOL_SETUP.md)
- Join our [Discord](https://discord.gg/otedama) community

---

Need help? Check our [Troubleshooting Guide](docs/TROUBLESHOOTING.md) or ask in Discord!