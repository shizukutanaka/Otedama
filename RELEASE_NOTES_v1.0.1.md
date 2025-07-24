# Release Notes - Otedama v1.0.1

**Release Date:** January 23, 2025

## 🎉 Overview

Otedama v1.0.1 brings significant enhancements to the miner experience with new features for individual BTC address registration, hardware selection, and intelligent mining modes. This update focuses on giving miners more control and flexibility while maintaining the simplicity that makes Otedama accessible to everyone.

## ✨ What's New

### 🏦 Individual BTC Address Registration
Miners can now register their own Bitcoin payout addresses, giving them full control over their earnings:
- Secure address validation (supports Legacy, SegWit, and Bech32)
- Easy configuration through the new CLI
- Address change history tracking
- Per-miner payment customization

### 🖥️ Advanced Hardware Control
Take full control of your mining hardware:
- **CPU/GPU Selection** - Choose to mine with CPU, GPU, or both
- **Auto-detection** - Automatically detects available GPUs
- **Thread Management** - Configure exact CPU thread count
- **Temperature Control** - Built-in temperature monitoring and throttling

### 🤖 Intelligent Mining Modes

#### Idle Mining
- Automatically starts mining when your PC is idle
- Configurable idle time (default: 5 minutes)
- Pauses instantly when you return
- Perfect for utilizing spare computing power

#### Background Mining
- Run minimized to system tray
- Quick access to controls via tray menu
- Start on system boot option
- Continues mining even when you close the window

### 🛠️ New Miner CLI (`otedama-miner`)

A dedicated command-line interface for miners:

```bash
# Configure your miner
otedama-miner config

# Start mining with options
otedama-miner start --idle --minimized

# Check mining status
otedama-miner status
```

Features:
- Interactive configuration wizard
- Real-time hashrate monitoring
- Visual feedback for shares and temperature
- Easy hardware configuration

## 📚 Documentation Updates

- **New Miner Guide** - Comprehensive guide covering all miner features
- **Updated Getting Started** - Simplified onboarding for new users
- **Enhanced Pool Setup** - Clearer instructions for pool operators
- **Improved API docs** - Better examples and explanations

## 🔧 Technical Improvements

- Enhanced GPU detection for Windows and Linux
- Improved memory management for long-running operations
- Better error handling and recovery
- Optimized share validation performance

## 📦 Installation

### New Installation
```bash
npm install -g otedama@1.0.1
```

### Upgrade from v1.0.0
```bash
npm update -g otedama
```

## 🔄 Migration Guide

### For Existing Miners

1. **Update Otedama**
   ```bash
   npm update -g otedama
   ```

2. **Configure Your BTC Address**
   ```bash
   otedama-miner config
   # Select "Set BTC Address"
   # Enter your Bitcoin address
   ```

3. **Review Hardware Settings**
   ```bash
   otedama-miner config
   # Select "Hardware Settings"
   # Configure CPU/GPU usage
   ```

4. **Start Mining**
   ```bash
   otedama-miner start
   ```

### For Pool Operators

No changes required. The update is fully backward compatible with existing pools.

## 🐛 Bug Fixes

- Fixed GPU detection on certain NVIDIA drivers
- Resolved memory leak in long-running mining sessions
- Corrected share submission timing issues
- Fixed configuration file path resolution on Windows

## 🚀 Coming Next

In future releases:
- Mobile app for remote monitoring
- Advanced profit switching algorithms
- Enhanced pool federation features
- Web-based miner dashboard

## 💬 Community

- Discord: [Join our server](https://discord.gg/otedama)
- GitHub: [Report issues](https://github.com/otedama/otedama/issues)
- Twitter: [@otedama](https://twitter.com/otedama)

## 🙏 Acknowledgments

Special thanks to our community for their feedback and contributions that made this release possible!

---

**Happy Mining!** ⛏️💎

*The Otedama Team*