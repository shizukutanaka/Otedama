# Otedama - P2P Mining Pool Software

<div align="center">
  
[![Version](https://img.shields.io/badge/version-1.0.2-blue.svg)](https://github.com/otedama/otedama/releases)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)
[![Languages](https://img.shields.io/badge/languages-100%2B-orange.svg)](docs/LANGUAGES.md)
[![Security](https://img.shields.io/badge/security-enhanced-red.svg)](SECURITY.md)

**Industry-Lowest Fees • 100+ Languages • Enterprise Security • One-Click Setup**

[English](#) | [日本語](README_ja.md) | [中文](README_zh.md) | [Español](README_es.md) | [More Languages...](docs/README_LANGUAGES.md)

</div>

## 🌟 What's New in v1.0.2

### 🔒 **Immutable Fee System**
- Pool fee hardcoded at 1% (tamper-proof)
- Operator addresses cryptographically protected
- Runtime integrity monitoring
- Automatic shutdown on tampering detection

### 🚀 **Performance & Security**
- 4x faster share validation with worker threads
- Advanced DDoS protection
- PostgreSQL backend for scalability
- Hardware wallet support (Ledger/Trezor)

[View Full Changelog](CHANGELOG.md)

## 🎯 Why Otedama?

### 💰 **Lowest Fees in the Industry**
| Pool | Fee | Your Earnings (per $1000) |
|------|-----|-------------------------|
| **Otedama** | **1%** | **$990** |
| Competitor A | 2% | $980 |
| Competitor B | 2.5% | $975 |

### 🌍 **True Global Accessibility**
- **100+ Languages** - From English to Zulu
- **RTL Support** - Arabic, Hebrew, Persian, Urdu
- **Auto-Detection** - Uses your system language
- **No Language Barriers** - Mine in your native language

### 🚀 **One-Click Setup**
```bash
# Windows
quick-start.bat

# Linux/macOS
./quick-start.sh
```
That's it! Mining in 60 seconds.

## ⚡ Quick Start

### Prerequisites
- Node.js 18+ 
- Git
- PostgreSQL 13+ (for production)

### Installation

```bash
# Clone repository
git clone https://github.com/otedama/otedama.git
cd otedama

# Install dependencies
npm install

# Run setup wizard
npm run setup
```

### Start Mining Pool

```bash
# Production mode with security checks
node start-pool.js

# Development mode
npm run dev
```

### Connect Your Miner

```bash
# Any Stratum-compatible miner
minerd -o stratum+tcp://localhost:3333 -u YOUR_BTC_ADDRESS -p x
```

## 🏗️ Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│                 │     │              │     │                 │
│  Secure Stratum │◄────┤ Share Valid- │◄────┤ Payment System  │
│     Server      │     │   ator       │     │  (PPLNS/PPS)   │
│                 │     │              │     │                 │
└────────┬────────┘     └──────┬───────┘     └────────┬────────┘
         │                     │                       │
         │              ┌──────▼───────┐               │
         │              │              │               │
         └──────────────┤ Pool Manager ├───────────────┘
                        │              │
                        └──────┬───────┘
                               │
                        ┌──────▼───────┐
                        │              │
                        │  PostgreSQL  │
                        │   Database   │
                        │              │
                        └──────────────┘
```

## 🔒 Security Features

### Immutable Configuration
- **Fixed 1% Pool Fee** - Cannot be modified
- **Protected Operator Address** - Cryptographically verified
- **Runtime Monitoring** - Detects tampering attempts
- **Build-time Protection** - Webpack plugin verification

### Advanced Protection
- **DDoS Mitigation** - Rate limiting and IP banning
- **Share Validation** - Fraud detection patterns
- **SSL/TLS Support** - Encrypted connections
- **2FA Ready** - Two-factor authentication

## 📊 Features

### Mining
- ✅ **Multi-Algorithm** - SHA256, Scrypt, Ethash, RandomX, KawPow
- ✅ **Smart Switching** - AI-powered profitability optimization
- ✅ **VarDiff** - Automatic difficulty adjustment
- ✅ **GPU Optimization** - 30% memory usage reduction

### Payments
- ✅ **Multiple Schemes** - PPLNS, PPS, PROP, PPLNT
- ✅ **Hardware Wallets** - Ledger & Trezor support
- ✅ **Hot/Cold Wallets** - Automatic fund management
- ✅ **Batch Processing** - Efficient transaction handling

### Management
- ✅ **Web Dashboard** - Real-time statistics
- ✅ **REST API** - Full pool control
- ✅ **Auto-Scaling** - Handle growth automatically
- ✅ **Health Monitoring** - Automatic issue detection

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