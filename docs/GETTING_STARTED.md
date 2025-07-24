# Getting Started with Otedama

## 🎯 Overview

Otedama is a P2P mining pool software that makes cryptocurrency mining accessible to everyone. This guide will help you get started quickly.

## 📋 Prerequisites

- **Node.js**: Version 18.0.0 or higher
- **RAM**: Minimum 4GB (8GB recommended)
- **Storage**: SSD with at least 10GB free space
- **Network**: Stable internet connection

## 🚀 Installation

### Option 1: NPM (Recommended)
```bash
npm install -g otedama
```

### Option 2: From Source
```bash
git clone https://github.com/otedama/otedama.git
cd otedama
npm install
npm link
```

## ⛏️ For Miners

### 1. Configure Your BTC Address
```bash
otedama-miner config
```
Select "Set BTC Address" and enter your Bitcoin address.

### 2. Configure Hardware
```bash
otedama-miner config
```
Select "Hardware Settings" to configure:
- CPU mining (number of threads)
- GPU mining (device selection)

### 3. Start Mining
```bash
# Basic mining
otedama-miner start

# Mine only when idle
otedama-miner start --idle

# Start minimized
otedama-miner start --minimized
```

### 4. Monitor Your Mining
```bash
otedama-miner status
```

## 🏊 For Pool Operators

### 1. Initial Setup
```bash
otedama start --wizard
```

The wizard will guide you through:
- Pool name and description
- Fee percentage (0.5-2%)
- Minimum payout threshold
- Network mode selection

### 2. Start Your Pool
```bash
# Start pool
otedama start

# Start in specific mode
otedama pool     # Pool mode only
otedama miner    # Miner mode only
```

### 3. Access Dashboard
Open your browser to:
```
http://localhost:3000
```

## 🔧 Configuration Files

### Miner Configuration
Location: `config/miner-client-config.json`

Key settings:
- `btcAddress`: Your Bitcoin payout address
- `hardware.useCPU`: Enable/disable CPU mining
- `hardware.useGPU`: Enable/disable GPU mining
- `idleMining.enabled`: Mine only when PC is idle

### Pool Configuration
Location: `config/pool-config.json`

Key settings:
- `pool.name`: Your pool's name
- `pool.fee`: Pool fee percentage
- `pool.minPayout`: Minimum payout amount

## 🌐 Network Modes

### Standalone Mode
- Single server operation
- Complete control
- No external dependencies

### P2P Mode
- Join decentralized network
- Share work with other pools
- Increased resilience

### Hybrid Mode
- Best of both worlds
- Local and P2P operation
- Maximum flexibility

## 📊 Monitoring

### Real-time Stats
- Hashrate monitoring
- Active miners count
- Share acceptance rate
- Temperature monitoring

### API Access
```bash
# Pool stats
curl http://localhost:3000/api/stats

# Miner list
curl http://localhost:3000/api/miners

# Recent blocks
curl http://localhost:3000/api/blocks
```

## 🔐 Security Tips

1. **Secure Your Wallet**
   - Use a hardware wallet for large amounts
   - Keep private keys offline
   - Regular backups

2. **Pool Security**
   - Enable SSL/TLS
   - Use strong passwords
   - Regular security updates

3. **Network Security**
   - Configure firewall rules
   - Use VPN for remote access
   - Monitor for unusual activity

## 🆘 Troubleshooting

### Common Issues

**Miner won't start**
- Check BTC address is configured
- Verify Node.js version
- Check port availability

**Low hashrate**
- Update GPU drivers
- Check temperature throttling
- Adjust intensity settings

**Connection issues**
- Check firewall settings
- Verify pool address
- Test network connectivity

### Getting Help
- Check [Troubleshooting Guide](TROUBLESHOOTING.md)
- Join our [Discord](https://discord.gg/otedama)
- Search [GitHub Issues](https://github.com/otedama/otedama/issues)

## 📈 Next Steps

1. **Optimize Performance**
   - Fine-tune hardware settings
   - Monitor and adjust intensity
   - Enable performance mode

2. **Join Community**
   - Discord server
   - GitHub discussions
   - Twitter updates

3. **Advanced Features**
   - Custom algorithms
   - Multi-pool mining
   - Automated switching

---

Happy Mining! 🎉