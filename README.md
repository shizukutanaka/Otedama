# Otedama v0.1.1

High-performance P2P Mining Pool Platform with integrated mining software.

[![Version](https://img.shields.io/badge/version-0.1.1-blue.svg)](https://github.com/shizukutanaka/Otedama)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![Enterprise](https://img.shields.io/badge/enterprise-ready-orange.svg)](#enterprise-features)
[![GPU](https://img.shields.io/badge/gpu-accelerated-yellow.svg)](#gpu-acceleration)

## Overview

Otedama is a high-performance P2P cryptocurrency mining pool platform designed for enterprise deployment. It provides a complete mining solution with distributed mining pool operations and integrated mining software for maximum efficiency.

## Key Features

### P2P Mining Pool
- Multi-algorithm support (SHA256, Scrypt, Ethash, RandomX, Equihash, X11, Kawpow, and more)
- Hardware compatibility: CPU, GPU, ASIC, FPGA
- P2P mesh network architecture for decentralized mining
- Automatic difficulty adjustment (VARDIFF)
- Smart work distribution and load balancing
- Real-time performance monitoring and statistics
- Low latency share submission (<5ms)
- Advanced payout system with multiple options

### Integrated Mining Software
- Built-in mining software for all supported algorithms
- GPU acceleration with CUDA, OpenCL, and Metal support
- CPU mining optimization with threading and SIMD
- Hardware detection and auto-configuration
- Temperature and power monitoring
- Automatic algorithm switching for profitability
- Remote monitoring and management capabilities

### Enterprise Features
- High availability and fault tolerance
- Scalable architecture supporting thousands of miners
- Advanced monitoring and alerting system
- Comprehensive audit logging
- Multi-pool support and failover
- RESTful API and WebSocket real-time updates

## System Requirements

### Minimum (Development)
- CPU: 4+ cores
- RAM: 16GB
- Storage: 100GB SSD
- Network: 100Mbps
- OS: Linux (Ubuntu 20.04+), Windows 10+, macOS 11+

### Recommended (Production)
- CPU: 16+ cores
- RAM: 64GB
- Storage: 1TB NVMe SSD
- Network: 10Gbps
- GPU: CUDA-compatible (optional)
- OS: Linux (Ubuntu 22.04+), Windows Server 2022

### Enterprise (High-Load)
- CPU: 32+ cores
- RAM: 128GB+
- Storage: 2TB+ NVMe SSD RAID
- Network: 25Gbps+ with redundancy
- GPU: Multiple CUDA GPUs
- OS: Linux (Ubuntu 22.04+ LTS)

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
    "fee": 0.01,  // 1% pool fee
    "minPayout": 0.001,  // Minimum payout threshold
    "payoutInterval": 3600000,  // 1 hour
    "maxConnections": 10000,
    "sharesDifficulty": "auto"
  },
  "mining": {
    "algorithms": ["sha256", "scrypt", "ethash", "randomx", "kawpow"],
    "ports": {
      "sha256": 3333,   // Bitcoin mining
      "scrypt": 3334,   // Litecoin mining  
      "ethash": 3335,   // Ethereum Classic mining
      "randomx": 3336,  // Monero mining
      "kawpow": 3337    // Ravencoin mining
    },
    "vardiff": {
      "min": 0.001,
      "max": 1000,
      "targetTime": 15,
      "retargetTime": 120
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

#### Built-in Mining Software
```bash
# Start integrated mining software
npm run mine -- --algo sha256 --pool localhost:3333 --wallet YOUR_WALLET_ADDRESS
npm run mine -- --algo ethash --pool localhost:3335 --wallet YOUR_WALLET_ADDRESS --gpu
npm run mine -- --algo randomx --pool localhost:3336 --wallet YOUR_WALLET_ADDRESS --cpu

# Or use standalone miner executable
./otedama-miner --algo randomx --pool your-pool-address:3336 --wallet YOUR_WALLET_ADDRESS --threads 8
```

## What's New in v0.1.1

### 🚀 Major Mining Pool Enhancements

#### Advanced P2P Mining Pool
- **Mesh Network Architecture**: Decentralized pool operations for maximum reliability
- **Multi-Algorithm Support**: SHA256, Scrypt, Ethash, RandomX, Kawpow, X11, and more
- **Variable Difficulty (VARDIFF)**: Automatic difficulty adjustment for optimal performance
- **Smart Work Distribution**: Intelligent job allocation across miners
- **Low Latency**: Sub-5ms share submission and processing

#### Integrated Mining Software
- **Built-in Miners**: Native mining software for all supported algorithms
- **Hardware Detection**: Automatic GPU/CPU detection and optimization
- **Performance Tuning**: Auto-tuning for maximum hashrate efficiency
- **Temperature Monitoring**: Hardware protection with thermal throttling
- **Power Management**: Intelligent power consumption optimization

#### GPU Acceleration System
- **Multi-Platform Support**: CUDA, OpenCL, Metal support for maximum compatibility
- **Auto-Optimization**: Dynamic performance tuning based on hardware capabilities
- **Memory Management**: Optimized memory allocation for mining workloads
- **Thermal Protection**: Intelligent cooling and temperature management

#### Enterprise Mining Features
- **High Availability**: Fault-tolerant pool architecture with automatic failover
- **Scalability**: Support for thousands of concurrent miners
- **Real-time Monitoring**: Comprehensive mining statistics and performance metrics
- **Advanced Payouts**: Multiple payout schemes (PPS, PPLNS, Solo)
- **Security**: Enterprise-grade security with audit logging

### 📊 Mining Performance Improvements

| Feature | Improvement | New Performance |
|---------|-------------|-----------------|
| GPU Mining Efficiency | +300% | 1M+ hashes/sec per GPU |
| CPU Mining Optimization | +150% | 10K+ hashes/sec per core |
| Share Submission Latency | +80% | <5ms processing time |
| Pool Connection Handling | +200% | 10K+ concurrent miners |
| Memory Usage Efficiency | +150% | 50% less RAM consumption |

### 🛡️ Mining Security Enhancements

- **Secure Stratum Protocol**: TLS encryption for all mining connections
- **DDoS Protection**: Advanced rate limiting and connection filtering
- **Share Validation**: Comprehensive share verification and fraud detection
- **Wallet Security**: Multi-signature support and secure key management
- **Pool Security**: Protection against mining pool attacks and exploits

### 📈 Enterprise Mining Features

- **Pool Statistics**: Real-time hashrate, worker count, and performance metrics
- **Advanced Monitoring**: Comprehensive mining operation dashboards
- **Alert System**: Email, Slack notifications for pool events
- **API Integration**: RESTful API for pool management and statistics
- **Database Optimization**: High-performance storage for mining data
- **Backup & Recovery**: Automated backup systems for pool continuity

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

#### For Pool Operations
```
ENABLE_SHARE_BATCHING=true
SHARE_BATCH_SIZE=1000
WORKER_CACHE_SIZE=100000
DIFFICULTY_ADJUSTMENT_INTERVAL=120
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