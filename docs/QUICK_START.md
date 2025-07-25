# Otedama Quick Start Guide

## Prerequisites

Before starting, ensure you have:
- Node.js 18+ installed
- 8GB+ RAM available
- Basic command line knowledge

## 5-Minute Setup

### 1. Download and Install

```bash
# Clone the repository
git clone https://github.com/otedama/otedama.git
cd otedama

# Install dependencies
npm install
```

### 2. Configure Your Pool

```bash
# Copy example configuration
cp .env.example .env

# Edit configuration (use any text editor)
nano .env
```

**Minimal configuration (.env):**
```env
# Your pool name
POOL_NAME=My First Mining Pool

# Your wallet address (where pool fees go)
POOL_ADDRESS=YOUR_WALLET_ADDRESS_HERE

# Pool fee (1% = 0.01)
POOL_FEE=0.01

# Leave these as default for now
STRATUM_PORT=3333
API_PORT=8080
```

### 3. Start Your Pool

```bash
# Start the mining pool
npm run start:pool
```

That's it! Your pool is now running.

## Connect Your First Miner

### Using Otedama Built-in Miner (Testing)

Open a new terminal:
```bash
# Start a test miner
npm run start:miner -- -o stratum+tcp://localhost:3333 -u YOUR_WALLET.test
```

### Using Real Mining Software

**CPU Mining (cpuminer):**
```bash
minerd -o stratum+tcp://localhost:3333 -u YOUR_WALLET.worker1 -p x
```

**GPU Mining (T-Rex for NVIDIA):**
```bash
t-rex -a ethash -o stratum+tcp://localhost:3333 -u YOUR_WALLET.rig1 -p x
```

**ASIC Configuration:**
- Pool URL: `stratum+tcp://your-ip:3333`
- Worker: `YOUR_WALLET.asic1`
- Password: `x`

## View Your Pool Dashboard

Open your web browser and go to:
```
http://localhost:8080
```

You'll see:
- Current hashrate
- Connected miners
- Recent shares
- Pool statistics

## Common Mining Algorithms

Otedama supports multiple algorithms. Set in your config:

```javascript
// otedama.config.js
export default {
  algorithm: 'sha256',  // Bitcoin
  // algorithm: 'scrypt',  // Litecoin
  // algorithm: 'ethash',  // Ethereum
  // algorithm: 'randomx', // Monero
}
```

## Quick Commands

### Pool Management
```bash
# Start pool
npm run start:pool

# Start with more workers (better performance)
npm run start:pool:cluster

# Check pool health
npm run health

# View logs
tail -f logs/pool.log
```

### Miner Testing
```bash
# Test with different algorithms
npm run start:miner -- -a scrypt
npm run start:miner -- -a ethash

# Multiple test miners
npm run start:miner -- -u WALLET.test1 &
npm run start:miner -- -u WALLET.test2 &
```

## Basic Troubleshooting

### Pool Won't Start

1. **Port already in use:**
   ```bash
   # Change port in .env
   STRATUM_PORT=4444
   ```

2. **Permission denied:**
   ```bash
   # Run with sudo (not recommended)
   sudo npm run start:pool
   
   # Better: Allow Node.js to bind to port
   sudo setcap 'cap_net_bind_service=+ep' $(which node)
   ```

### No Miners Connecting

1. **Check firewall:**
   ```bash
   # Ubuntu/Debian
   sudo ufw allow 3333/tcp
   
   # CentOS/RHEL
   sudo firewall-cmd --add-port=3333/tcp --permanent
   sudo firewall-cmd --reload
   ```

2. **Check pool is running:**
   ```bash
   curl http://localhost:8080/api/stats
   ```

### Low Hashrate

1. **Enable cluster mode:**
   ```bash
   npm run start:pool:cluster
   ```

2. **Increase workers:**
   ```bash
   npm run start:pool -- --workers 8
   ```

## Next Steps

### 1. Connect to Real Blockchain

Edit `.env`:
```env
# Bitcoin example
BITCOIN_RPC_URL=http://localhost:8332
BITCOIN_RPC_USER=bitcoinrpc
BITCOIN_RPC_PASSWORD=your_rpc_password
```

### 2. Configure Payments

```javascript
// otedama.config.js
export default {
  paymentScheme: 'PPLNS',  // or 'PPS', 'PROP', 'SOLO'
  minimumPayment: 0.01,     // Minimum payout
  paymentInterval: 3600000, // 1 hour in milliseconds
}
```

### 3. Enable Security

```javascript
// otedama.config.js
export default {
  security: {
    enableDDoSProtection: true,
    enableBanManagement: true,
    rateLimiting: true
  }
}
```

### 4. Setup Domain Name

1. Point your domain to your server IP
2. Configure nginx:
   ```nginx
   server {
       server_name pool.example.com;
       
       location / {
           proxy_pass http://localhost:8080;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
       }
   }
   ```

### 5. Enable SSL

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx

# Get SSL certificate
sudo certbot --nginx -d pool.example.com
```

## Useful Resources

- **Documentation**: `/docs` folder
- **API Reference**: `http://localhost:8080/api/docs`
- **Community Discord**: [Join here](https://discord.gg/otedama)
- **Video Tutorials**: [YouTube Channel](https://youtube.com/otedama)

## Quick Tips

1. **Monitor Performance**: Watch CPU and memory usage
   ```bash
   htop
   ```

2. **Check Logs**: Always check logs for errors
   ```bash
   tail -f logs/*.log
   ```

3. **Backup Regularly**: Backup your data directory
   ```bash
   tar -czf backup-$(date +%Y%m%d).tar.gz data/
   ```

4. **Update Frequently**: Keep Otedama updated
   ```bash
   git pull
   npm update
   ```

## Getting Help

- **Common Issues**: Check `/docs/TROUBLESHOOTING.md`
- **Discord Support**: Real-time help from community
- **GitHub Issues**: Report bugs and request features
- **Email Support**: support@otedama.io

---

Congratulations! You're now running your own mining pool. 

For advanced configuration and production deployment, see the full documentation.