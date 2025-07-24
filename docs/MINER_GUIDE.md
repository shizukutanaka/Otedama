# Otedama Miner Guide

## 🎯 Overview

This comprehensive guide covers everything you need to know about mining with Otedama.

## 🚀 Quick Start

```bash
# Install Otedama
npm install -g otedama

# Configure your BTC address
otedama-miner config

# Start mining
otedama-miner start
```

## 💰 BTC Address Setup

### Setting Your Payout Address
```bash
otedama-miner config
# Select "Set BTC Address"
# Enter your Bitcoin address
```

### Supported Address Types
- **Legacy (P2PKH)**: Starts with `1`
- **SegWit (P2SH)**: Starts with `3`
- **Native SegWit (Bech32)**: Starts with `bc1`

### Address Security
- Never share your private keys
- Use a secure wallet
- Consider hardware wallets for large amounts

## 🖥️ Hardware Configuration

### CPU Mining

**Enable/Disable CPU**
```bash
otedama-miner config
# Select "Hardware Settings"
# Toggle "Use CPU for mining"
```

**Thread Configuration**
- **Auto**: Uses 50% of available threads
- **Manual**: Specify exact thread count
- **Recommended**: Leave 2-4 threads for system

### GPU Mining

**Supported GPUs**
- NVIDIA (CUDA)
- AMD (OpenCL)
- Intel (OpenCL)

**GPU Selection**
```bash
# Use all GPUs
"gpuDevices": "all"

# Use specific GPUs
"gpuDevices": "0,1,3"
```

**Optimization Tips**
- Update drivers regularly
- Monitor temperatures
- Adjust power limits

## ⚙️ Mining Modes

### 1. Standard Mining
```bash
otedama-miner start
```
- Runs in foreground
- Full performance
- Manual control

### 2. Background Mining
```bash
otedama-miner start --background
```
- Runs as background process
- Continues after terminal close
- System tray integration

### 3. Idle Mining
```bash
otedama-miner start --idle
```
- Mines only when PC is idle
- Configurable idle time
- Auto-pause on activity

### 4. Minimized Start
```bash
otedama-miner start --minimized
```
- Starts minimized to tray
- Reduces desktop clutter
- Quick access via tray

## 🔧 Performance Tuning

### Intensity Settings

**CPU Intensity** (0-100)
```json
"cpuIntensity": 50  // Balanced
"cpuIntensity": 80  // High performance
"cpuIntensity": 30  // Low impact
```

**GPU Intensity** (0-100)
```json
"gpuIntensity": 80  // Recommended
"gpuIntensity": 95  // Maximum
"gpuIntensity": 60  // Conservative
```

### Temperature Management

**Temperature Limits**
```json
"temperatureLimit": 80  // °C
```

**Auto-throttling**
- Reduces intensity at limit
- Pauses at limit + 10°C
- Resumes when cooled

### Power Efficiency

**Battery Mode**
```json
"pauseOnBattery": true
```

**Process Priority**
- `low`: Minimal system impact
- `normal`: Balanced (default)
- `high`: Maximum performance

## 🎮 Idle Mining Configuration

### Basic Setup
```json
{
  "idleMining": {
    "enabled": true,
    "idleTime": 300000,      // 5 minutes
    "pauseOnActivity": true,
    "resumeDelay": 5000      // 5 seconds
  }
}
```

### Activity Detection
- Mouse movement
- Keyboard input
- Active window changes
- CPU usage spikes

### Customization
```bash
# Configure via CLI
otedama-miner config
# Select "Idle Mining Settings"
```

## 📊 Monitoring & Stats

### Real-time Monitoring
```bash
otedama-miner status
```

Shows:
- Current hashrate
- Accepted/rejected shares
- Temperature readings
- Uptime statistics

### Performance Metrics
- **Hashrate**: Mining speed (H/s, KH/s, MH/s)
- **Shares**: Work units submitted
- **Efficiency**: Accepted share ratio
- **Temperature**: Hardware temperatures

### Log Files
Location: `logs/miner.log`

View logs:
```bash
tail -f logs/miner.log
```

## 🌐 Pool Selection

### Default Pool
```json
{
  "pools": [{
    "name": "Otedama Pool",
    "url": "stratum+tcp://localhost:3333",
    "priority": 1
  }]
}
```

### Multiple Pools
```json
{
  "pools": [
    {
      "name": "Primary Pool",
      "url": "stratum+tcp://pool1.example.com:3333",
      "priority": 1
    },
    {
      "name": "Backup Pool",
      "url": "stratum+tcp://pool2.example.com:3333",
      "priority": 2
    }
  ]
}
```

### Pool Failover
- Automatic switching on failure
- Priority-based selection
- Connection retry logic

## 🛡️ Security Best Practices

### Wallet Security
1. Use dedicated mining wallet
2. Enable 2FA where possible
3. Regular balance checks
4. Secure backup strategy

### System Security
1. Keep software updated
2. Use antivirus software
3. Monitor for unusual activity
4. Secure network connection

### Mining Security
1. Verify pool SSL certificates
2. Use strong worker passwords
3. Monitor for hash theft
4. Regular payout withdrawals

## 🔧 Troubleshooting

### Low Hashrate
- Check driver updates
- Verify cooling system
- Adjust intensity settings
- Check for throttling

### Connection Issues
- Verify pool address
- Check firewall settings
- Test network connectivity
- Try alternative pools

### Hardware Errors
- Update drivers
- Check power supply
- Monitor temperatures
- Test hardware stability

### Share Rejections
- Check system time
- Verify network latency
- Update mining software
- Contact pool support

## 🚀 Advanced Features

### Custom Algorithms
```bash
# Configure algorithm
otedama-miner config --algo SHA256
```

### Multi-Algorithm Mining
- Auto-switching based on profitability
- Manual algorithm selection
- Performance optimization per algo

### Remote Management
- Web dashboard access
- API control
- Mobile monitoring
- Alert notifications

## 📈 Optimization Tips

### Hardware Optimization
1. **Overclocking**
   - Gradual increases
   - Stability testing
   - Temperature monitoring

2. **Undervolting**
   - Reduce power consumption
   - Lower temperatures
   - Maintain performance

3. **Memory Timing**
   - Optimize for algorithm
   - Test stability
   - Monitor errors

### Software Optimization
1. **Driver Selection**
   - Use mining-specific drivers
   - Regular updates
   - Compatibility testing

2. **OS Tuning**
   - Disable unnecessary services
   - Optimize power settings
   - Configure virtual memory

3. **Mining Software**
   - Keep updated
   - Test beta versions
   - Compare alternatives

## 📚 Resources

### Documentation
- [API Reference](API_REFERENCE.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [FAQ](FAQ.md)

### Community
- Discord: [Join Server](https://discord.gg/otedama)
- Reddit: r/otedama
- Twitter: @otedama

### Tools
- Profitability calculators
- Overclocking utilities
- Monitoring software
- Wallet managers

---

Happy Mining! ⛏️💎