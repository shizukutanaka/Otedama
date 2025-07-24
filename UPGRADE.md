# Upgrade Guide - Otedama v1.0.0 to v1.0.1

## 📋 Overview

This guide helps you upgrade from Otedama v1.0.0 to v1.0.1. The upgrade process is straightforward and maintains backward compatibility.

## ✨ What's New in v1.0.1

- Individual BTC address registration for miners
- CPU/GPU selection and hardware control
- Idle mining mode
- Background/system tray operation
- New `otedama-miner` CLI tool
- Enhanced documentation

## 🔄 Upgrade Methods

### Method 1: NPM Update (Recommended)

```bash
# Update global installation
npm update -g otedama

# Verify new version
otedama --version
# Should show: 1.0.1
```

### Method 2: Reinstall

```bash
# Uninstall old version
npm uninstall -g otedama

# Install new version
npm install -g otedama@1.0.1

# Verify installation
otedama --version
```

### Method 3: From Source

```bash
# Navigate to otedama directory
cd otedama

# Pull latest changes
git pull origin master

# Install dependencies
npm install

# Rebuild native modules
npm rebuild

# Verify version
node index.js --version
```

## 🛠️ Post-Upgrade Steps

### For Miners

1. **Configure BTC Address** (New Feature!)
   ```bash
   otedama-miner config
   ```
   - Select "Set BTC Address"
   - Enter your Bitcoin address

2. **Review Hardware Settings**
   ```bash
   otedama-miner config
   ```
   - Select "Hardware Settings"
   - Configure CPU/GPU usage

3. **Test New Features**
   ```bash
   # Try idle mining
   otedama-miner start --idle
   
   # Try minimized mode
   otedama-miner start --minimized
   ```

### For Pool Operators

1. **Check Pool Status**
   ```bash
   otedama health-check
   ```

2. **Review Configuration**
   - No changes required to existing configs
   - New miner features work automatically

3. **Monitor Dashboard**
   - Access at `http://localhost:3000`
   - Check for any warnings

## 📁 Configuration Migration

### Automatic Migration
The upgrade process automatically preserves your existing configuration files.

### Manual Backup (Optional)
```bash
# Backup existing config
cp -r config/ config-backup-v1.0.0/

# Backup database
cp data/otedama.db data/otedama-v1.0.0.db
```

## 🔍 Verification Steps

### 1. Check Installation
```bash
# Verify CLI tools
which otedama
which otedama-miner

# Check versions
otedama --version
otedama-miner --version
```

### 2. Test Miner Features
```bash
# Test configuration
otedama-miner config

# Test mining
otedama-miner start
# Press Ctrl+C to stop
```

### 3. Test Pool (if applicable)
```bash
# Start pool
otedama start

# Check logs
tail -f logs/pool.log
```

## ⚠️ Breaking Changes

**None!** v1.0.1 is fully backward compatible with v1.0.0.

## 🆘 Troubleshooting

### Command Not Found

If `otedama-miner` is not found:
```bash
# Reinstall globally
npm install -g otedama --force

# Or link manually
npm link
```

### Native Module Errors

If you see errors about native modules:
```bash
# Rebuild modules
cd $(npm root -g)/otedama
npm rebuild

# For Windows
npm install -g windows-build-tools
npm rebuild
```

### Configuration Issues

If configuration seems corrupted:
```bash
# Reset miner config
rm config/miner-client-config.json
otedama-miner config
```

### Permission Errors

Linux/macOS:
```bash
# Fix permissions
sudo chown -R $(whoami) ~/.npm
sudo chown -R $(whoami) /usr/local/lib/node_modules
```

Windows:
- Run command prompt as Administrator
- Reinstall Otedama

## 🔙 Rollback Procedure

If you need to rollback to v1.0.0:

```bash
# Uninstall current version
npm uninstall -g otedama

# Install specific version
npm install -g otedama@1.0.0

# Restore backup (if created)
cp -r config-backup-v1.0.0/* config/
```

## 📊 Performance Improvements

v1.0.1 includes several performance enhancements:
- Optimized GPU detection
- Improved memory management
- Better error recovery
- Faster share validation

## 🎯 Best Practices

1. **Backup First**
   - Always backup configs and data
   - Test in development first

2. **Monitor After Upgrade**
   - Watch logs for errors
   - Check resource usage
   - Verify miner connections

3. **Gradual Rollout**
   - Upgrade one system first
   - Monitor for 24 hours
   - Then upgrade remaining systems

## 📚 Additional Resources

- [Release Notes](RELEASE_NOTES_v1.0.1.md)
- [Miner Guide](docs/MINER_GUIDE.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Discord Support](https://discord.gg/otedama)

## 💬 Getting Help

If you encounter issues:

1. Check the [Troubleshooting Guide](docs/TROUBLESHOOTING.md)
2. Search [GitHub Issues](https://github.com/otedama/otedama/issues)
3. Ask in [Discord](https://discord.gg/otedama)
4. Create a new issue with:
   - Your OS and Node.js version
   - Error messages
   - Steps to reproduce

---

Thank you for using Otedama! 🎉