# Otedama

Enterprise-grade P2P mining pool platform with integrated DEX and DeFi capabilities.

## Overview

Otedama is a high-performance cryptocurrency platform designed for enterprise deployment. It combines mining pool operations, decentralized exchange functionality, and DeFi features in a single, optimized codebase.

## Key Features

### Mining Pool
- Multi-algorithm support (SHA256, Scrypt, Ethash, RandomX, Equihash, X11, and more)
- Hardware compatibility: CPU, GPU, ASIC, FPGA
- P2P mesh network architecture
- Automatic difficulty adjustment
- Smart work distribution
- Real-time performance monitoring

### Decentralized Exchange
- High-frequency order matching (<1ms latency)
- Multiple order types (market, limit, stop-loss)
- Liquidity aggregation
- MEV protection
- Cross-chain support

### DeFi Platform
- Automated market maker (AMM)
- Yield farming and staking
- Flash loans
- Governance system

## System Requirements

- CPU: 8+ cores recommended
- RAM: 16GB minimum, 64GB recommended
- Storage: 500GB SSD minimum
- Network: 1Gbps+ connection
- OS: Linux (Ubuntu 20.04+), Windows Server 2019+

## Quick Start

### Docker Installation (Recommended)
```bash
docker-compose up -d
```

### Manual Installation
```bash
# Install dependencies
npm install

# Configure environment
cp .env.production.example .env.production

# Run database migrations
npm run migrate

# Start the platform
npm start
```

## Configuration

### Mining Pool Setup
```javascript
{
  "pool": {
    "name": "Your Pool Name",
    "fee": 0.01,  // 1% fee
    "minPayout": 0.001,
    "payoutInterval": 3600000  // 1 hour
  },
  "mining": {
    "algorithms": ["sha256", "scrypt", "ethash"],
    "ports": {
      "sha256": 3333,
      "scrypt": 3334,
      "ethash": 3335
    }
  }
}
```

### Connecting Miners

#### ASIC Miners
```
stratum+tcp://your-pool-address:3333
Username: YOUR_WALLET_ADDRESS
Password: x
```

#### GPU Mining (Example with T-Rex Miner)
```bash
t-rex -a ethash -o stratum+tcp://your-pool-address:3335 -u YOUR_WALLET_ADDRESS -p x
```

#### CPU Mining
```bash
./otedama-miner --algo randomx --pool your-pool-address:3336 --wallet YOUR_WALLET_ADDRESS
```

## API Documentation

### REST API
Base URL: `http://localhost:8080/api`

#### Get Pool Statistics
```
GET /api/stats
```

#### Get Miner Statistics
```
GET /api/miner/{address}
```

#### Submit Share
```
POST /api/submit
Content-Type: application/json

{
  "worker": "worker-name",
  "jobId": "job-id",
  "nonce": "nonce-value",
  "hash": "hash-result"
}
```

### WebSocket API
```javascript
const ws = new WebSocket('ws://localhost:3334');

// Subscribe to real-time updates
ws.send(JSON.stringify({
  type: 'subscribe',
  channels: ['hashrate', 'blocks', 'trades']
}));
```

## Performance Optimization

### Recommended Settings

#### For Mining Operations
```
NODE_OPTIONS="--max-old-space-size=8192"
UV_THREADPOOL_SIZE=128
```

#### For DEX Operations
```
ENABLE_BATCH_PROCESSING=true
BATCH_SIZE=1000
CACHE_SIZE=100000
```

## Monitoring

### Prometheus Metrics
Metrics are exposed at `http://localhost:9091/metrics`

### Grafana Dashboard
Pre-configured dashboards available at `http://localhost:3000`

## Security

- TLS 1.3 encryption for all connections
- Rate limiting and DDoS protection
- Multi-signature wallet support
- Regular security audits

## Troubleshooting

### Common Issues

#### High CPU Usage
- Reduce worker thread count in configuration
- Enable CPU affinity settings
- Check for memory leaks with `npm run profile`

#### Connection Issues
- Verify firewall settings
- Check port availability
- Review connection pool limits

#### Mining Issues
- Ensure correct algorithm selection
- Verify wallet address format
- Check network difficulty settings

## Support

- GitHub Issues: https://github.com/shizukutanaka/Otedama/issues
- Documentation: See `/docs` folder

## License

MIT License - see LICENSE file for details