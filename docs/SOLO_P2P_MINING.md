# Solo P2P Mining Documentation

## Overview

Otedama's Solo P2P Mining mode is designed for miners who want complete independence while maintaining the option for P2P collaboration. This mode is perfect for:

- Individual miners who want to mine directly to their wallet
- Small mining operations that don't want pool fees
- Miners who value privacy and control
- Operations that need resilience without centralized dependencies

## How It Works

### Pure Solo Mode
When P2P is disabled, the miner operates completely independently:
1. Connects directly to your full node
2. Mines blocks and submits them to the blockchain
3. Receives full block rewards directly to your wallet
4. No sharing of rewards or dependency on others

### P2P-Enhanced Solo Mode
When P2P is enabled, you gain additional benefits:
1. Share mining work with other solo miners
2. Increased chance of finding blocks through collaboration
3. Automatic failover if your node goes down
4. Share statistics and best practices with peers
5. Still receive rewards directly to your wallet

## Quick Start

### 1. Basic Solo Mining
```bash
# Start solo mining with auto-detected settings
otedama solo --wallet YOUR_WALLET_ADDRESS

# Specify algorithm and threads
otedama solo --wallet YOUR_WALLET --algorithm randomx --threads 8
```

### 2. Solo Mining with P2P
```bash
# Enable P2P for redundancy
otedama solo --wallet YOUR_WALLET --p2p

# Connect to specific peers
otedama solo --wallet YOUR_WALLET --p2p --config config.solo.yaml
```

### 3. Using Configuration File
Create `config.solo.yaml`:
```yaml
wallet: "YOUR_WALLET_ADDRESS"
algorithm: "randomx"
threads: 0  # 0 = auto
enable_p2p: true
bootstrap_peers:
  - "peer1.example.com:18080"
  - "peer2.example.com:18080"
```

Then run:
```bash
otedama solo --config config.solo.yaml
```

## Configuration Options

### Mining Settings
- `wallet`: Your cryptocurrency wallet address (required)
- `algorithm`: Mining algorithm (sha256d, scrypt, ethash, randomx, etc.)
- `threads`: Number of CPU threads (0 = auto-detect)
- `intensity`: Mining intensity 1-100 (affects power/heat)
- `node_rpc`: Your full node RPC endpoint

### P2P Settings
- `enable_p2p`: Enable P2P networking (default: false)
- `p2p_port`: P2P listening port (default: 18080)
- `bootstrap_peers`: Initial peers to connect to
- `max_peers`: Maximum peer connections (default: 50)

### Performance Settings
- `cpu_affinity`: Pin threads to specific CPU cores
- `gpu_devices`: GPU device indices for GPU mining
- `auto_tune`: Automatically optimize settings

## Operating Modes

### 1. Standalone Solo Mining
```yaml
enable_p2p: false
threads: 8
intensity: 100
```
- Complete independence
- No network overhead
- Direct block submission
- Full privacy

### 2. P2P Collaborative Solo
```yaml
enable_p2p: true
bootstrap_peers:
  - "trusted-peer1.com:18080"
  - "trusted-peer2.com:18080"
max_peers: 10
```
- Share work with trusted peers
- Maintain individual rewards
- Resilient to node failures
- Community collaboration

### 3. Hybrid Mode
The system automatically switches between solo and P2P based on conditions:
- Solo when no peers available
- P2P when peers are connected
- Automatic optimization based on network state

## Performance Optimization

### CPU Mining
```yaml
# Optimize for Ryzen 9 5950X
threads: 16
cpu_affinity: [0,2,4,6,8,10,12,14,16,18,20,22,24,26,28,30]  # Physical cores
intensity: 95
```

### GPU Mining
```yaml
# Single GPU
gpu_devices: [0]
threads: 1  # One thread per GPU
intensity: 90

# Multi-GPU
gpu_devices: [0, 1, 2, 3]
threads: 4
intensity: 85
```

### Mixed CPU+GPU
```yaml
threads: 4  # CPU threads
gpu_devices: [0, 1]  # GPUs
intensity: 80  # Balance heat/power
```

## Monitoring and Statistics

### Real-time Statistics
The miner displays statistics every 30 seconds:
```
=== Otedama Solo Mining Statistics ===
Miner ID:    a3f4b2c1d8e7f6a5
Algorithm:   randomx
Threads:     16
Hashrate:    15420 H/s
Difficulty:  25.34
Shares:      1523
Blocks:      2
Earnings:    12.50000000

P2P Status:  Enabled
Peers:       3
=====================================
```

### API Access
```bash
# Get JSON statistics
curl http://localhost:8080/api/solo/stats

# Get peer information
curl http://localhost:8080/api/solo/peers
```

## Advanced Features

### Share Chain
When P2P is enabled, a local share chain tracks mining progress:
- Proves work contribution
- Enables peer verification
- Provides mining statistics
- No financial implications (rewards still direct)

### Automatic Difficulty Adjustment
The miner automatically adjusts difficulty to maintain optimal performance:
- Target: 1 share per 10 seconds
- Adjusts based on hashrate
- Prevents excessive disk I/O
- Optimizes for your hardware

### Failover Support
With P2P enabled:
1. Primary: Your configured node
2. Secondary: Peer-provided work
3. Tertiary: Cached work continuation

## Security Considerations

### Private Key Security
- Wallet private keys never leave your system
- Only public addresses are shared
- No pool has access to your funds

### P2P Security
- Optional peer authentication
- Encrypted communications available
- IP address privacy options
- Firewall-friendly operation

### Mining Security
- Protected against block withholding
- Share validation prevents cheating
- Local verification of all work

## Troubleshooting

### Low Hashrate
```bash
# Check CPU frequency scaling
otedama diagnose cpu

# Optimize settings
otedama solo --auto-tune
```

### No Peers Found
```bash
# Check firewall
sudo ufw allow 18080/tcp

# Test connectivity
otedama network test --port 18080
```

### High Rejection Rate
```bash
# Verify node sync
otedama diagnose node

# Check network latency
otedama diagnose network
```

## Best Practices

1. **Hardware Setup**
   - Adequate cooling for 24/7 operation
   - Stable power supply
   - Error-correcting RAM for servers

2. **Network Configuration**
   - Low latency connection to node
   - Static IP for P2P operation
   - Firewall rules for P2P port

3. **Monitoring**
   - Set up alerts for low hashrate
   - Monitor temperature and power
   - Track block finding rate

4. **Backup**
   - Keep wallet backups secure
   - Document configuration
   - Test recovery procedures

## FAQ

**Q: How is this different from pool mining?**
A: You receive block rewards directly to your wallet with no pool fees. You maintain complete control and privacy.

**Q: Can I mine different cryptocurrencies?**
A: Yes, configure the algorithm and node RPC for your chosen cryptocurrency.

**Q: What happens if no peers are available?**
A: The miner continues in pure solo mode with no interruption.

**Q: Is P2P mode less secure?**
A: No, your wallet and rewards remain completely under your control. P2P only shares work coordination.

**Q: Can I limit P2P to trusted peers?**
A: Yes, configure specific bootstrap peers and disable peer discovery.

## Support

For additional help:
- GitHub Issues: https://github.com/shizukutanaka/Otedama/issues
- Documentation: See the `/docs` directory
- Community: Create issues on GitHub for support and discussions