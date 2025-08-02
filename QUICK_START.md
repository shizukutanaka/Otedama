# Otedama Quick Start Guide

## Start Mining in 5 Minutes

### 1. Download Otedama

Download the latest release for your platform:
- **Linux**: otedama-linux-amd64
- **Windows**: otedama-windows-amd64.exe
- **macOS**: otedama-darwin-amd64 (Intel) or otedama-darwin-arm64 (Apple Silicon)

### 2. Basic Mining Commands

#### Solo Mining (Single Miner)
Mine directly to your wallet:
```bash
./otedama solo --wallet YOUR_WALLET_ADDRESS --algorithm sha256d
```

#### Pool Mining
Connect to a mining pool:
```bash
./otedama pool --url stratum+tcp://pool.example.com:3333 --wallet YOUR_WALLET --worker myworker
```

#### P2P Mining
Join a P2P network:
```bash
./otedama p2p join --bootstrap 192.168.1.100:3333
```

### 3. Simple Configuration

Create a `config.yaml` file:
```yaml
mining:
  algorithm: sha256d
  threads: 4  # Number of CPU threads
  
wallet: YOUR_WALLET_ADDRESS

# Optional GPU settings
gpu:
  enabled: true
  device: 0
```

Run with configuration:
```bash
./otedama start --config config.yaml
```

### 4. Monitor Your Mining

Check status:
```bash
./otedama status
```

View dashboard (opens in browser):
```bash
./otedama dashboard
```

### 5. Common Operations

**Stop mining**: Press `Ctrl+C`

**Check earnings**:
```bash
./otedama profit
```

**Update software**:
```bash
./otedama update
```

## Troubleshooting

### Low Hashrate
- Increase CPU threads: `--threads 8`
- Enable GPU: `--gpu`
- Check temperature: `./otedama monitor temp`

### Connection Issues
- Check firewall settings
- Verify pool address
- Try different bootstrap nodes

### High CPU Usage
- Reduce threads: `--threads 2`
- Enable efficiency mode: `--efficiency`

## Need Help?

- Run `./otedama help` for all commands
- Check logs: `./otedama logs`
- Report issues: https://github.com/shizukutanaka/Otedama/issues

## Advanced Features

Once comfortable with basic mining:
- Enable ZKP authentication for privacy
- Set up automated profit switching
- Configure multi-algorithm mining
- Join enterprise P2P pools

Start simple, scale when ready!