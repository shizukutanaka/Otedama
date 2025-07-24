# Otedama - P2P Mining Pool Software

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/otedama/otedama)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)

Simple, Efficient, and Scalable P2P Mining Pool Software

## 🚀 Quick Start

```bash
# Install
npm install -g otedama

# Start pool
otedama start

# Start miner with BTC address registration
otedama-miner config
otedama-miner start --idle --minimized
```

## ✨ Key Features

### For Miners
- **BTC Address Registration** - Set your own payout address
- **CPU/GPU Selection** - Choose mining hardware
- **Idle Mining** - Mine when your PC is idle
- **Background Mining** - Run minimized in system tray
- **Auto-start** - Start mining on boot

### For Pool Operators
- **P2P Architecture** - Decentralized and resilient
- **Multi-Algorithm** - Support for various mining algorithms
- **Low Fees** - Competitive 0.5-1% pool fees
- **Real-time Stats** - Live monitoring and analytics
- **100+ Languages** - Global accessibility

## 📋 Requirements

- Node.js >= 18.0.0
- 4GB RAM minimum
- SSD storage recommended
- Stable internet connection

## 🔧 Installation

### From NPM
```bash
npm install -g otedama
```

### From Source
```bash
git clone https://github.com/shizukutanaka/otedama.git
cd otedama
npm install
npm link
```

## 🎮 Miner Usage

### Configure BTC Address
```bash
otedama-miner config
# Select "Set BTC Address"
# Enter your Bitcoin address
```

### Start Mining
```bash
# Basic start
otedama-miner start

# Start with idle detection (mines when PC is idle)
otedama-miner start --idle

# Start minimized to tray
otedama-miner start --minimized

# Start in background
otedama-miner start --background
```

### Hardware Configuration
```bash
otedama-miner config
# Select "Hardware Settings"
# Configure CPU/GPU usage
```

## 🏊 Pool Operation

### Start Pool
```bash
# Start with wizard
otedama start --wizard

# Start with existing config
otedama start
```

### Pool Modes
- **Standalone** - Single server pool
- **P2P Network** - Join decentralized network
- **Hybrid** - Both modes simultaneously

## 🛠️ Configuration

### Miner Config (`config/miner-client-config.json`)
```json
{
  "miner": {
    "btcAddress": "YOUR_BTC_ADDRESS",
    "hardware": {
      "useCPU": true,
      "useGPU": true,
      "cpuThreads": 0
    },
    "idleMining": {
      "enabled": false,
      "idleTime": 300000
    }
  }
}
```

### Pool Config (`config/pool-config.json`)
```json
{
  "pool": {
    "name": "My Otedama Pool",
    "fee": 1.0,
    "minPayout": 0.001
  }
}
```

## 📊 Monitoring

### Miner Status
```bash
otedama-miner status
```

### Pool Dashboard
```
http://localhost:3000
```

### API Endpoints
- `/api/stats` - Pool statistics
- `/api/miners` - Active miners
- `/api/blocks` - Found blocks

## 🔒 Security

- SSL/TLS encryption
- DDoS protection
- Rate limiting
- Address validation
- Secure wallet integration

## 🌍 Supported Algorithms

- SHA256 (Bitcoin)
- Scrypt (Litecoin)
- Ethash (Ethereum Classic)
- RandomX (Monero)
- Kawpow (Ravencoin)
- And more...

## 📚 Documentation

- [Getting Started](docs/GETTING_STARTED.md)
- [Miner Guide](docs/MINER_GUIDE.md)
- [Pool Setup](docs/POOL_SETUP.md)
- [API Reference](docs/API_REFERENCE.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## 📄 License

This project is licensed under the MIT License - see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- Bitcoin Core developers
- Stratum protocol contributors
- Open source mining community

---

Made with ❤️ by the Otedama Team