# Otedama - Professional P2P Mining Pool & DEX Platform

**Start mining cryptocurrencies in minutes with our enterprise-grade P2P mining pool. Supports 13 coins, 10 algorithms, and all hardware types.**

## Quick Start (5 Minutes)

### Windows
```batch
# Download and run
curl -O https://otedama.io/quickstart.bat
quickstart.bat
# Open http://localhost:8080 in your browser
```

### Linux/macOS
```bash
# Download and run
curl -O https://otedama.io/quickstart.sh
chmod +x quickstart.sh
./quickstart.sh
# Open http://localhost:8080 in your browser
```

### Docker (Recommended for Production)
```bash
docker run -d -p 8080:8080 -p 3333:3333 otedama/otedama:latest
# Open http://localhost:8080
```

## Supported Cryptocurrencies & Algorithms

| Coin | Algorithm | Hardware | Port |
|------|-----------|----------|------|
| Bitcoin (BTC) | SHA256 | ASIC | 3333 |
| Ethereum (ETH) | Ethash | GPU | 3334 |
| Ravencoin (RVN) | KawPow | GPU | 3335 |
| Monero (XMR) | RandomX | CPU | 3336 |
| Litecoin (LTC) | Scrypt | ASIC | 3337 |
| Dogecoin (DOGE) | Scrypt | ASIC | 3337 |
| Zcash (ZEC) | Equihash | ASIC/GPU | 3338 |
| Dash (DASH) | X11 | ASIC | 3339 |
| Ethereum Classic (ETC) | Ethash | GPU | 3334 |
| Ergo (ERGO) | Autolykos | GPU | 3340 |
| Flux (FLUX) | Equihash | GPU | 3341 |
| Kaspa (KAS) | kHeavyHash | ASIC | 3342 |
| Alephium (ALPH) | Blake3 | ASIC | 3343 |

## Payout Options

### Option 1: Keep Your Mined Coins
- Mine any supported cryptocurrency
- Receive payouts in the same coin
- **Fee: 1.8% (paid in BTC equivalent)**
- Example: Mine 1 ETH → Receive 1 ETH, pay 0.018 BTC fee

### Option 2: Auto-Convert to Bitcoin
- Mine any cryptocurrency
- Automatically convert to BTC
- **Fee: 2% total (includes conversion)**
- Example: Mine 1 ETH → Receive BTC equivalent minus 2%

## Mining Examples

### GPU Mining (NVIDIA/AMD)
```bash
# Ethereum
t-rex -a ethash -o stratum+tcp://pool.address:3334 -u YOUR_ETH_WALLET -p x

# Ravencoin
teamredminer -a kawpow -o stratum+tcp://pool.address:3335 -u YOUR_RVN_WALLET -p x

# Ergo
nbminer -a ergo -o stratum+tcp://pool.address:3340 -u YOUR_ERGO_WALLET -p x
```

### CPU Mining
```bash
# Monero (XMR)
xmrig -a rx/0 -o stratum+tcp://pool.address:3336 -u YOUR_XMR_WALLET -p x
```

### ASIC Mining
```bash
# Bitcoin (Antminer)
Pool URL: stratum+tcp://pool.address:3333
Worker: YOUR_BTC_WALLET
Password: x

# Litecoin/Dogecoin (L3+)
Pool URL: stratum+tcp://pool.address:3337
Worker: YOUR_LTC_OR_DOGE_WALLET
Password: x
```

## Features

### Mining Pool
- **P2P Architecture**: Decentralized, no single point of failure
- **Smart Difficulty**: Auto-adjusts to your hardware
- **Stratum V2**: Latest protocol with enhanced security
- **Real-time Stats**: Live hashrate, earnings, and network data
- **Low Latency**: Global server network
- **DDoS Protection**: Enterprise-grade security

### Integrated DEX
- **50+ Trading Pairs**: Trade between all supported coins
- **No KYC**: Completely anonymous
- **Atomic Swaps**: Trustless cross-chain trades
- **Low Fees**: 0.1% trading fee
- **MEV Protection**: Front-running prevention

### Mobile App (PWA)
- Monitor mining stats
- Manage payouts
- Trade on DEX
- Real-time notifications
- Works offline

### API Access
```bash
# Get pool stats
curl https://api.pool.address/stats

# Get miner stats
curl https://api.pool.address/miners/YOUR_WALLET

# Get market data
curl https://api.pool.address/markets
```

## System Requirements

### Minimum
- CPU: 2 cores
- RAM: 4GB
- Storage: 20GB
- Network: 100 Mbps

### Recommended
- CPU: 8 cores
- RAM: 16GB
- Storage: 100GB SSD
- Network: 1 Gbps

## Configuration

### Basic Settings
```json
{
  "pool": {
    "fee": 0.018,
    "minPayout": 0.001,
    "payoutInterval": 3600
  },
  "stratum": {
    "ports": {
      "sha256": 3333,
      "ethash": 3334,
      "kawpow": 3335,
      "randomx": 3336
    }
  }
}
```

### Advanced Configuration
See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for all options.

## Support

### Documentation
- [Mining Guide](docs/MINING_GUIDE.md)
- [API Reference](docs/API.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

### Community
- Discord: https://discord.gg/otedama
- Telegram: https://t.me/otedama
- Reddit: https://reddit.com/r/otedama

### Languages Supported
Arabic (AR), Bengali (BN), Chinese (ZH), Dutch (NL), English (EN), French (FR), German (DE), Hindi (HI), Indonesian (ID), Italian (IT), Japanese (JA), Korean (KO), Polish (PL), Portuguese (PT), Russian (RU), Spanish (ES), Turkish (TR), Vietnamese (VI), and 45+ more languages.

## License

MIT License - See [LICENSE](LICENSE) file for details.

## Security

- SSL/TLS encryption
- DDoS protection
- Rate limiting
- Input validation
- Regular security audits

Report security issues to: security@otedama.io

---
**Otedama** - Professional mining made simple.