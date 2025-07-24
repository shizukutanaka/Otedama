# Otedama Enhanced Mining Pool Setup Guide

## Overview

This guide covers the setup and configuration of the enhanced Otedama mining pool with production-ready security, performance optimizations, and comprehensive monitoring.

## Prerequisites

- Node.js 18+ 
- PostgreSQL 13+ (for production)
- Bitcoin Core node (or compatible cryptocurrency node)
- Redis (optional, for caching)
- SSL certificate (for production)

## Installation

1. **Install dependencies:**
```bash
npm install
```

2. **Install additional required packages:**
```bash
npm install lru-cache pg bignumber.js
```

3. **Setup PostgreSQL database:**
```sql
CREATE DATABASE otedama_pool;
CREATE USER otedama WITH ENCRYPTED PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE otedama_pool TO otedama;
```

## Configuration

1. **Copy and edit the pool configuration:**
```bash
cp config/pool-manager-config.json config/pool-manager-config.local.json
```

2. **Update critical settings in `config/pool-manager-config.local.json`:**

### Required Changes:
- `pool.wallet.encryptionKey`: Generate with `openssl rand -hex 32`
- `pool.database.password`: Set your PostgreSQL password
- `pool.blockchain.node.user`: Your Bitcoin RPC username
- `pool.blockchain.node.password`: Your Bitcoin RPC password
- `pool.wallet.coldWalletAddress`: Your cold storage address

### Example Configuration:
```json
{
  "pool": {
    "name": "My Mining Pool",
    "stratum": {
      "port": 3333,
      "maxConnections": 10000
    },
    "blockchain": {
      "coin": "BTC",
      "network": "mainnet",
      "node": {
        "host": "localhost",
        "port": 8332,
        "user": "bitcoinrpc",
        "password": "your_rpc_password"
      }
    },
    "payment": {
      "scheme": "PPLNS",
      "poolFee": 0.01,
      "minimumPayout": 0.001
    }
  }
}
```

## Running the Pool

### Development Mode:
```bash
node start-pool.js --config config/pool-manager-config.local.json --verbose
```

### Production Mode:
```bash
NODE_ENV=production node start-pool.js --config config/pool-manager-config.json
```

### With PM2 (recommended for production):
```bash
pm2 start start-pool.js --name "otedama-pool" -- --config config/pool-manager-config.json
pm2 save
pm2 startup
```

## Testing

### Run Integration Test:
```bash
node test/integration/pool-integration-test.js
```

### Connect Test Miner:
```bash
# Using cpuminer
minerd -o stratum+tcp://localhost:3333 -u YOUR_BTC_ADDRESS -p x

# Using cgminer
cgminer -o stratum+tcp://localhost:3333 -u YOUR_BTC_ADDRESS -p x
```

## Security Checklist

- [ ] Change default encryption key
- [ ] Set strong database password
- [ ] Configure firewall rules
- [ ] Enable SSL for Stratum (production)
- [ ] Set up cold wallet address
- [ ] Configure DDoS protection
- [ ] Enable monitoring alerts
- [ ] Regular security audits

## Monitoring

The pool provides comprehensive monitoring through:

1. **Real-time Statistics:**
   - Connected miners
   - Pool hashrate
   - Share statistics
   - Block information

2. **Health Checks:**
   - Stratum server status
   - Blockchain connectivity
   - Database health
   - Payment system status

3. **Alerts:**
   - Hot wallet balance low
   - High invalid share rate
   - Pool efficiency degradation
   - Blockchain disconnection

## API Endpoints

The pool exposes a REST API for monitoring and management:

- `GET /api/stats` - Pool statistics
- `GET /api/miners` - Active miners list
- `GET /api/blocks` - Recent blocks
- `GET /api/payments` - Recent payments
- `GET /api/miner/:address` - Miner statistics

## Troubleshooting

### Common Issues:

1. **Cannot connect to blockchain node:**
   - Verify RPC credentials
   - Check if node is fully synced
   - Ensure RPC is enabled in bitcoin.conf

2. **Database connection failed:**
   - Check PostgreSQL is running
   - Verify credentials
   - Check firewall rules

3. **High invalid share rate:**
   - Check network latency
   - Verify difficulty settings
   - Monitor for malicious miners

### Logs:

Logs are stored in `./logs/` directory:
- `pool-manager.log` - Main pool operations
- `stratum-server.log` - Stratum connections
- `payment-system.log` - Payment processing
- `blockchain-monitor.log` - Blockchain events

## Performance Tuning

1. **Database Optimization:**
```sql
-- Run periodically
VACUUM ANALYZE;
REINDEX DATABASE otedama_pool;
```

2. **Node.js Settings:**
```bash
# Increase memory limit
node --max-old-space-size=4096 start-pool.js

# Enable clustering
NODE_CLUSTER_WORKERS=4 node start-pool.js
```

3. **System Tuning:**
```bash
# Increase file descriptors
ulimit -n 65536

# TCP tuning (add to /etc/sysctl.conf)
net.core.somaxconn = 65536
net.ipv4.tcp_tw_reuse = 1
```

## Backup and Recovery

1. **Database Backup:**
```bash
pg_dump -U otedama otedama_pool > backup.sql
```

2. **Wallet Backup:**
```bash
cp data/pool-wallet.json backups/wallet-$(date +%Y%m%d).json
```

3. **Configuration Backup:**
```bash
tar -czf config-backup.tar.gz config/
```

## Support

- GitHub Issues: https://github.com/otedama/otedama/issues
- Documentation: https://docs.otedama.io
- Community: https://discord.gg/otedama

## License

MIT License - See LICENSE file for details