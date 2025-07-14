# Mining Guide

This guide explains how to connect your mining hardware to Otedama pool.

## Quick Start

1. Start the Otedama pool:
```bash
otedama start -w YOUR_WALLET_ADDRESS --currency RVN
```

2. Connect your miner to:
```
stratum+tcp://YOUR_SERVER_IP:3333
Username: YOUR_WALLET_ADDRESS
Password: x
```

## Supported Algorithms

| Algorithm | Currency | Coin | Best Hardware |
|-----------|----------|------|---------------|
| SHA256    | BTC      | Bitcoin | ASIC > GPU > CPU |
| KawPow    | RVN      | Ravencoin | GPU > CPU |
| RandomX   | XMR      | Monero | CPU > GPU |
| Ethash    | ETC      | Ethereum Classic | GPU > CPU |

## Mining Software

### CPU Mining

#### XMRig (Monero/RandomX)
```bash
xmrig -o stratum+tcp://localhost:3333 -u YOUR_XMR_ADDRESS -p x
```

#### cpuminer (Multi-algorithm)
```bash
cpuminer -a sha256d -o stratum+tcp://localhost:3333 -u YOUR_BTC_ADDRESS -p x
```

### GPU Mining

#### T-Rex (NVIDIA - Ravencoin/KawPow)
```bash
t-rex -a kawpow -o stratum+tcp://localhost:3333 -u YOUR_RVN_ADDRESS -p x
```

#### TeamRedMiner (AMD - Ravencoin/KawPow)
```bash
teamredminer -a kawpow -o stratum+tcp://localhost:3333 -u YOUR_RVN_ADDRESS -p x
```

#### PhoenixMiner (Ethereum Classic/Ethash)
```bash
PhoenixMiner -pool stratum1+tcp://localhost:3333 -wal YOUR_ETC_ADDRESS -pass x
```

### ASIC Mining

For ASIC miners, configure through the web interface:
- Pool URL: `stratum+tcp://YOUR_SERVER_IP:3333`
- Username: `YOUR_WALLET_ADDRESS`
- Password: `x`

## Configuration Examples

### Otedama Configuration

Create `config.json`:
```json
{
  "mining": {
    "enabled": true,
    "currency": "RVN",
    "algorithm": "kawpow",
    "walletAddress": "YOUR_RVN_ADDRESS",
    "stratumPort": 3333,
    "difficulty": 0.001
  },
  "p2p": {
    "enabled": true,
    "port": 8333,
    "maxPeers": 50,
    "seedNodes": []
  },
  "api": {
    "enabled": true,
    "port": 8445,
    "host": "0.0.0.0"
  },
  "dataDir": "./data",
  "logLevel": "info"
}
```

### Multiple Workers

You can connect multiple workers using the same wallet address:
```
Worker 1: YOUR_WALLET_ADDRESS.worker1
Worker 2: YOUR_WALLET_ADDRESS.worker2
Worker 3: YOUR_WALLET_ADDRESS.rig1
```

## Difficulty Adjustment

The pool automatically adjusts difficulty based on your hashrate. Initial difficulty is set to 0.001.

## Monitoring

### Command Line
Check pool status:
```bash
curl http://localhost:8445/stats | jq
```

### Web Browser
Open `http://localhost:8445/stats` in your browser.

### Real-time Updates
Connect to WebSocket for live updates:
```javascript
const ws = new WebSocket('ws://localhost:8445');
ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'subscribe', channel: 'stats' }));
};
```

## Rewards

Otedama uses PPLNS (Pay Per Last N Shares) reward system:
- Fair distribution based on contributed shares
- Window size: 100,000 shares or 1 hour
- No pool fees in P2P mode
- Automatic payments when blocks are found

## Troubleshooting

### Miner Can't Connect
1. Check firewall settings - port 3333 must be open
2. Verify Otedama is running: `curl http://localhost:8445/health`
3. Check logs: `tail -f ./data/logs/otedama-*.log`

### Low Hashrate
1. Ensure correct algorithm for your hardware
2. Check temperature and power limits
3. Update mining software and drivers

### No Shares Accepted
1. Verify wallet address is correct
2. Check network connectivity
3. Ensure mining software is compatible

### High Reject Rate
1. Check network latency
2. Verify system clock is synchronized
3. Consider adjusting difficulty

## Performance Tips

### CPU Mining
- Use all available threads
- Enable huge pages (Linux)
- Disable CPU boost for stability
- Keep CPU temperature below 80°C

### GPU Mining
- Update to latest drivers
- Optimize memory timings
- Set appropriate power limit
- Ensure adequate cooling

### Network
- Use wired connection
- Minimize latency to pool
- Configure QoS for mining traffic

## Security

1. **Use Strong Passwords**: Even though password is usually 'x', some pools support worker passwords
2. **Firewall Rules**: Only allow necessary ports
3. **Monitor Connections**: Check for unauthorized miners
4. **Regular Updates**: Keep Otedama and mining software updated

## Example Setups

### Home Mining Rig
```bash
# Start Otedama
otedama start -w RNs3ne88DoNEnXFTqUrj6zrYejeQpcj4jk --currency RVN

# Connect GPU miner
t-rex -a kawpow -o stratum+tcp://localhost:3333 -u RNs3ne88DoNEnXFTqUrj6zrYejeQpcj4jk -p x
```

### Mining Farm
```bash
# Start Otedama with custom config
otedama start --config ./farm-config.json

# Connect multiple rigs
# Rig 1: YOUR_ADDRESS.rig1
# Rig 2: YOUR_ADDRESS.rig2
# etc.
```

### Cloud Mining
```bash
# Start Otedama on cloud server
otedama start -w YOUR_ADDRESS --currency BTC --api-port 80

# Connect remote miners to:
# stratum+tcp://your-server-ip:3333
```

## FAQ

**Q: What currencies are supported?**
A: Bitcoin (BTC), Ravencoin (RVN), Monero (XMR), Ethereum Classic (ETC)

**Q: Is there a pool fee?**
A: No fees in P2P mode

**Q: How often are payments?**
A: When blocks are found, rewards are calculated based on PPLNS

**Q: Can I mine multiple currencies?**
A: Run separate Otedama instances on different ports

**Q: Is SSL/TLS supported?**
A: Not in the current version

**Q: What's the minimum payout?**
A: Depends on the currency and network fees