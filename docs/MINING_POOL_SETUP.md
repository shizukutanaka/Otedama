# Otedama P2P Mining Pool Setup Guide

## Overview

Otedama is an enterprise-grade P2P (peer-to-peer) mining pool system that supports multiple cryptocurrencies and algorithms. This guide will help you set up and configure your own mining pool node.

## Table of Contents

1. [System Requirements](#system-requirements)
2. [Installation](#installation)
3. [Configuration](#configuration)
4. [Running the Pool](#running-the-pool)
5. [Connecting Miners](#connecting-miners)
6. [Monitoring and Management](#monitoring-and-management)
7. [Advanced Features](#advanced-features)
8. [Troubleshooting](#troubleshooting)

## System Requirements

### Minimum Requirements

- **CPU**: 4 cores (8 threads recommended)
- **RAM**: 8GB (16GB recommended)
- **Storage**: 100GB SSD
- **Network**: 100 Mbps dedicated connection
- **OS**: Ubuntu 20.04+ or Windows 10/11 with WSL2

### Recommended Requirements

- **CPU**: 8+ cores with AVX2 support
- **RAM**: 32GB or more
- **Storage**: 500GB+ NVMe SSD
- **Network**: 1 Gbps connection
- **GPU**: NVIDIA/AMD GPU for GPU mining support

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/your-org/otedama.git
cd otedama
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Build Native Modules (Optional)

For optimal performance, build native mining modules:

```bash
npm run build:native
```

### 4. Create Data Directory

```bash
mkdir -p data/mining-pool
```

## Configuration

### 1. Copy Environment Template

```bash
cp .env.mining .env
```

### 2. Edit Configuration

Open `.env` and configure your pool settings:

```env
# Pool Identity
POOL_NAME="My Otedama Pool"
NODE_ID=auto-generated-if-not-set

# Network Configuration
P2P_PORT=3333
STRATUM_PORT=3334
API_PORT=8080
DASHBOARD_PORT=8081

# Mining Configuration
AUTO_SELECT_ALGORITHM=true
PROFIT_SWITCHING=true
GPU_MINING=true
CPU_MINING=true
ELECTRICITY_COST=0.10

# Pool Fees
POOL_FEE=0.01
PAYOUT_THRESHOLD=0.001
```

### 3. Configure Coin Support

Add your preferred coins to the `.env` file:

```env
# Bitcoin
BTC_ENABLED=true
BTC_DAEMON_HOST=localhost
BTC_DAEMON_PORT=8332
BTC_DAEMON_USER=rpcuser
BTC_DAEMON_PASS=rpcpassword

# Ethereum
ETH_ENABLED=true
ETH_DAEMON_HOST=localhost
ETH_DAEMON_PORT=8545

# Add more coins as needed...
```

### 4. Bootstrap Nodes (Optional)

For joining an existing P2P network:

```env
BOOTSTRAP_NODES=[NODE1_ADDRESS]:3333,[NODE2_ADDRESS]:3333
```

## Running the Pool

### Start the Mining Pool

```bash
npm run start:pool
```

Or use the dedicated startup script:

```bash
node start-mining-pool.js
```

### Run in Production

For production deployment:

```bash
# Using PM2
pm2 start ecosystem.config.js

# Using systemd
sudo systemctl start otedama-pool
```

### Docker Deployment

```bash
# Build image
docker build -t otedama-pool .

# Run container
docker run -d \
  -p 3333:3333 \
  -p 3334:3334 \
  -p 8080:8080 \
  -p 8081:8081 \
  -v $(pwd)/data:/app/data \
  --name otedama-pool \
  otedama-pool
```

## Connecting Miners

### Stratum Connection

Miners can connect using standard Stratum protocol:

```
Server: stratum+tcp://your-pool-address:3334
Username: YOUR_WALLET_ADDRESS.WORKER_NAME
Password: x
```

### Supported Mining Software

- **GPU Mining**:
  - T-Rex Miner
  - GMiner
  - NBMiner
  - TeamRedMiner
  - lolMiner

- **CPU Mining**:
  - XMRig
  - CPUMiner-Opt

- **ASIC Mining**:
  - CGMiner
  - BFGMiner

### Example Configurations

#### T-Rex (NVIDIA GPUs)
```bash
t-rex -a ethash -o stratum+tcp://your-pool:3334 -u YOUR_ETH_ADDRESS.rig1 -p x
```

#### TeamRedMiner (AMD GPUs)
```bash
teamredminer -a ethash -o stratum+tcp://your-pool:3334 -u YOUR_ETH_ADDRESS.rig1 -p x
```

#### XMRig (CPU)
```bash
xmrig -a rx/0 -o stratum+tcp://your-pool:3334 -u YOUR_XMR_ADDRESS.rig1 -p x
```

## Monitoring and Management

### Web Dashboard

Access the monitoring dashboard at:
```
http://your-pool-address:8081
```

Features:
- Real-time hashrate monitoring
- Miner statistics
- Block history
- Profit analysis
- Alert management

### API Endpoints

The pool provides a comprehensive REST API:

```bash
# Pool statistics
GET http://your-pool:8080/api/pool/stats

# Miner statistics
GET http://your-pool:8080/api/miners
GET http://your-pool:8080/api/miners/{minerId}

# Algorithm information
GET http://your-pool:8080/api/algorithms

# Network status
GET http://your-pool:8080/api/network
```

### Command Line Interface

```bash
# Check pool status
npm run pool:status

# List connected miners
npm run pool:miners

# View recent blocks
npm run pool:blocks
```

## Advanced Features

### 1. Profit Switching

The pool automatically switches between profitable coins:

```env
PROFIT_SWITCHING=true
SWITCH_THRESHOLD=0.05  # Switch when 5% more profitable
MIN_MINING_TIME=600000 # Mine at least 10 minutes before switching
```

### 2. Merged Mining

Enable mining multiple chains simultaneously:

```env
MERGED_MINING=true
PARENT_CHAIN=BTC
AUX_CHAINS=NMC,SYS,ELA
```

### 3. Custom Algorithms

Add support for new algorithms:

```javascript
// lib/mining/algorithms/custom-algo.js
import { BaseAlgorithm } from './base-algorithm.js';

export class CustomAlgo extends BaseAlgorithm {
  constructor() {
    super('custom-algo');
  }
  
  async hash(data) {
    // Implement your algorithm
  }
}
```

### 4. High Availability

Configure multiple pool nodes for redundancy:

```env
FAULT_TOLERANCE=true
MIN_ACTIVE_NODES=3
REPLICATION_FACTOR=3
```

### 5. SSL/TLS Support

Enable secure connections:

```env
ENABLE_SSL=true
SSL_CERT_PATH=./certs/cert.pem
SSL_KEY_PATH=./certs/key.pem
```

## Performance Optimization

### 1. CPU Affinity

Optimize CPU core assignment:

```env
ENABLE_CPU_AFFINITY=true
CORE_ALLOCATION=dedicated
```

### 2. Memory Management

Configure memory limits:

```env
NODE_OPTIONS="--max-old-space-size=8192"
ENABLE_MEMORY_PROFILER=true
```

### 3. Network Optimization

```env
# Zero-copy protocol
ENABLE_ZERO_COPY=true

# Connection pooling
MAX_CONNECTIONS=10000
CONNECTION_TIMEOUT=30000
```

### 4. Database Optimization

```env
DB_READ_POOL_SIZE=10
DB_WRITE_POOL_SIZE=5
ENABLE_QUERY_CACHE=true
```

## Security Considerations

### 1. Firewall Configuration

```bash
# Allow Stratum
sudo ufw allow 3334/tcp

# Allow P2P
sudo ufw allow 3333/tcp

# Allow API (restrict to internal network)
sudo ufw allow from 192.168.0.0/16 to any port 8080
```

### 2. DDoS Protection

```env
ENABLE_DDOS_PROTECTION=true
RATE_LIMIT_WINDOW=60000
RATE_LIMIT_MAX=100
```

### 3. Authentication

```env
# API authentication
API_KEY=your-secure-api-key

# Stratum authentication
REQUIRE_STRATUM_AUTH=true
```

## Troubleshooting

### Common Issues

#### 1. Miners Can't Connect

- Check firewall settings
- Verify Stratum port is open
- Check logs: `tail -f logs/stratum.log`

#### 2. Low Hashrate

- Verify GPU drivers are installed
- Check GPU utilization: `nvidia-smi` or `rocm-smi`
- Review performance settings

#### 3. P2P Network Issues

- Ensure P2P port is accessible
- Check bootstrap nodes are reachable
- Review network logs: `tail -f logs/p2p.log`

#### 4. High Reject Rate

- Check network latency
- Verify share difficulty settings
- Review miner configurations

### Debug Mode

Enable detailed logging:

```env
LOG_LEVEL=debug
ENABLE_TRACE_LOGGING=true
```

### Health Check

```bash
# Run health check
npm run pool:health

# Check specific component
npm run pool:check -- --component=stratum
```

## Maintenance

### Regular Tasks

1. **Daily**:
   - Monitor hashrate trends
   - Check reject rates
   - Review error logs

2. **Weekly**:
   - Update coin daemon software
   - Clean old log files
   - Backup configuration

3. **Monthly**:
   - Update Otedama software
   - Review and optimize settings
   - Analyze profitability

### Backup

```bash
# Backup pool data
npm run pool:backup

# Restore from backup
npm run pool:restore -- --file=backup-2025-07-22.tar.gz
```

### Updates

```bash
# Check for updates
npm run pool:check-updates

# Update Otedama
git pull
npm install
npm run build:native
pm2 restart otedama-pool
```

## Support and Community

- **Documentation**: [Documentation]
- **Discord**: [Discord Server]
- **GitHub Issues**: https://github.com/otedama/otedama/issues
- **Email**: [Contact Support]

## License

Otedama is open-source software licensed under the MIT License.