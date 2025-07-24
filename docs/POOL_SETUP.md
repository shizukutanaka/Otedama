# Otedama Pool Setup Guide

## 🎯 Overview

This guide covers setting up and operating your own Otedama mining pool.

## 🚀 Quick Setup

```bash
# Install Otedama
npm install -g otedama

# Run setup wizard
otedama start --wizard

# Start pool
otedama start
```

## 📋 Prerequisites

### Hardware Requirements
- **CPU**: 4+ cores recommended
- **RAM**: 8GB minimum, 16GB recommended
- **Storage**: 50GB+ SSD space
- **Network**: 100Mbps+ connection

### Software Requirements
- Node.js 18.0.0+
- Git (for source installation)
- SSL certificate (production)
- Domain name (recommended)

## 🏗️ Installation Methods

### Method 1: NPM Package
```bash
npm install -g otedama
otedama --version
```

### Method 2: From Source
```bash
git clone https://github.com/otedama/otedama.git
cd otedama
npm install
npm link
```

### Method 3: Docker
```bash
docker pull otedama/pool
docker run -d -p 3333:3333 -p 3000:3000 otedama/pool
```

## 🧙 Setup Wizard

Run the interactive wizard:
```bash
otedama start --wizard
```

### Wizard Steps

1. **Pool Information**
   - Pool name
   - Description
   - Contact email
   - Website URL

2. **Network Configuration**
   - Stratum port (default: 3333)
   - Web port (default: 3000)
   - SSL configuration

3. **Fee Structure**
   - Pool fee percentage (0.5-2%)
   - Minimum payout
   - Payment frequency

4. **Mining Configuration**
   - Supported algorithms
   - Difficulty adjustment
   - Share validation

5. **Database Setup**
   - Database type
   - Connection settings
   - Backup configuration

## ⚙️ Configuration

### Main Configuration File
Location: `config/pool-config.json`

```json
{
  "pool": {
    "name": "My Otedama Pool",
    "description": "Fast and reliable mining pool",
    "fee": 1.0,
    "minPayout": 0.001,
    "payoutInterval": 3600
  },
  "stratum": {
    "port": 3333,
    "difficulty": 16,
    "varDiff": {
      "enabled": true,
      "minDiff": 8,
      "maxDiff": 512,
      "targetTime": 15
    }
  },
  "web": {
    "port": 3000,
    "ssl": {
      "enabled": false,
      "cert": "path/to/cert.pem",
      "key": "path/to/key.pem"
    }
  }
}
```

### Algorithm Configuration
Location: `config/algorithms.json`

```json
{
  "SHA256": {
    "enabled": true,
    "ports": [3333],
    "difficulty": 16
  },
  "Scrypt": {
    "enabled": true,
    "ports": [3334],
    "difficulty": 32
  }
}
```

## 🌐 Network Modes

### 1. Standalone Mode
```bash
otedama pool --mode standalone
```
- Independent operation
- Full control
- Single point of failure

### 2. P2P Network Mode
```bash
otedama pool --mode p2p
```
- Join decentralized network
- Share work distribution
- Increased resilience

### 3. Hybrid Mode
```bash
otedama pool --mode hybrid
```
- Both standalone and P2P
- Fallback capability
- Maximum flexibility

## 💰 Payment System

### Payment Configuration
```json
{
  "payments": {
    "enabled": true,
    "interval": 3600,
    "minPayout": 0.001,
    "maxPayout": 10.0,
    "fee": 0.0001,
    "daemon": {
      "host": "localhost",
      "port": 8332,
      "user": "rpcuser",
      "password": "rpcpass"
    }
  }
}
```

### Payment Methods
1. **PPLNS** (Pay Per Last N Shares)
   - Fair distribution
   - Prevents pool hopping
   - Stable earnings

2. **PPS** (Pay Per Share)
   - Instant payment
   - Pool takes risk
   - Fixed rate

3. **PROP** (Proportional)
   - Simple calculation
   - Round-based
   - Transparent

## 🔐 Security Setup

### SSL/TLS Configuration
```bash
# Generate self-signed certificate (development)
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365

# Configure in pool
otedama config set web.ssl.enabled true
otedama config set web.ssl.cert ./cert.pem
otedama config set web.ssl.key ./key.pem
```

### Firewall Rules
```bash
# Allow Stratum
sudo ufw allow 3333/tcp

# Allow Web Dashboard
sudo ufw allow 3000/tcp

# Allow SSL Web
sudo ufw allow 443/tcp
```

### DDoS Protection
```json
{
  "security": {
    "ddos": {
      "enabled": true,
      "maxConnections": 1000,
      "banTime": 600,
      "checkInterval": 1
    }
  }
}
```

## 📊 Monitoring

### Web Dashboard
Access at: `http://your-pool-domain:3000`

Features:
- Real-time statistics
- Miner management
- Payment history
- Performance graphs

### API Endpoints
```bash
# Pool statistics
GET /api/stats

# Active miners
GET /api/miners

# Recent blocks
GET /api/blocks

# Payment history
GET /api/payments
```

### Monitoring Tools
```bash
# Check pool health
otedama health-check

# View logs
tail -f logs/pool.log

# Monitor performance
otedama monitor
```

## 🚀 Performance Optimization

### Database Optimization
```bash
# Optimize database
otedama optimize-db

# Configure indexes
otedama db index-create
```

### Caching Configuration
```json
{
  "cache": {
    "enabled": true,
    "redis": {
      "host": "localhost",
      "port": 6379
    },
    "ttl": {
      "stats": 5,
      "miners": 10,
      "shares": 60
    }
  }
}
```

### Load Balancing
```json
{
  "loadBalancing": {
    "enabled": true,
    "servers": [
      "pool1.example.com:3333",
      "pool2.example.com:3333"
    ]
  }
}
```

## 🔧 Maintenance

### Regular Tasks
1. **Daily**
   - Check logs for errors
   - Monitor hashrate
   - Verify payments

2. **Weekly**
   - Database backup
   - Security updates
   - Performance review

3. **Monthly**
   - Full system backup
   - Software updates
   - Fee adjustment review

### Backup Procedures
```bash
# Backup database
otedama backup create

# Backup configuration
cp -r config/ config-backup/

# Automated backups
otedama backup schedule --interval daily
```

### Update Process
```bash
# Check for updates
otedama update check

# Update Otedama
npm update -g otedama

# Restart pool
otedama restart
```

## 📈 Scaling

### Horizontal Scaling
```json
{
  "cluster": {
    "enabled": true,
    "workers": 4,
    "stratumPorts": [3333, 3334, 3335, 3336]
  }
}
```

### Geographical Distribution
- Multiple server locations
- GeoDNS routing
- Regional stratum servers

### High Availability
```json
{
  "ha": {
    "enabled": true,
    "mode": "active-passive",
    "heartbeat": 5,
    "failover": "automatic"
  }
}
```

## 🆘 Troubleshooting

### Common Issues

**Pool won't start**
- Check port availability
- Verify configuration
- Check log files

**Miners can't connect**
- Firewall settings
- Stratum port open
- DNS resolution

**Payments failing**
- Wallet daemon running
- RPC credentials correct
- Sufficient balance

### Debug Mode
```bash
# Enable debug logging
otedama start --debug

# Verbose output
otedama start -vvv
```

## 📚 Advanced Features

### Custom Coin Integration
```javascript
// config/coins/mycoin.json
{
  "name": "MyCoin",
  "symbol": "MYC",
  "algorithm": "SHA256",
  "blockTime": 600,
  "blockReward": 50
}
```

### Plugin System
```bash
# Install plugin
otedama plugin install otedama-plugin-telegram

# Configure plugin
otedama plugin config telegram
```

### API Extensions
```javascript
// api/custom-endpoint.js
module.exports = (app) => {
  app.get('/api/custom', (req, res) => {
    res.json({ custom: 'data' });
  });
};
```

## 📞 Support

### Documentation
- [API Reference](API_REFERENCE.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [FAQ](FAQ.md)

### Community
- Discord: [Join Server](https://discord.gg/otedama)
- Forum: forum.otedama.io
- Email: support@otedama.io

---

Good luck with your pool! 🏊‍♂️💎