# Otedama Light - Configuration Guide

## Environment Variables

Create a `.env` file in the root directory with the following variables:

```bash
# Required
STRATUM_PORT=3333              # Port for miner connections
RPC_URL=http://localhost:8332  # Bitcoin node RPC URL
RPC_USER=bitcoinrpc           # RPC username
RPC_PASSWORD=yourpassword     # RPC password
POOL_ADDRESS=bc1qxxxxx       # Pool's Bitcoin address
POOL_FEE=1.0                  # Pool fee percentage (1.0 = 1%)

# Optional
NODE_ENV=production           # Environment (development/production)
LOG_LEVEL=info               # Logging level (debug/info/warn/error)
```

## Bitcoin Node Configuration

Add these lines to your `bitcoin.conf`:

```
# Enable RPC
server=1
rpcuser=bitcoinrpc
rpcpassword=yourpassword
rpcallowip=127.0.0.1

# For testnet
testnet=1

# For mainnet (remove testnet=1)
#testnet=0
```

## Stratum Connection

Miners can connect using standard Stratum protocol:

### CGMiner/BFGMiner
```bash
cgminer -o stratum+tcp://localhost:3333 -u YOUR_BITCOIN_ADDRESS -p x
```

### Connection String Format
```
stratum+tcp://POOL_HOST:STRATUM_PORT
Username: YOUR_BITCOIN_ADDRESS.WORKER_NAME
Password: x (or anything)
```

## API Endpoints

The pool exposes a simple REST API on port 8080:

- `GET /api/stats` - Pool statistics
- `GET /api/miners` - List of active miners
- `GET /api/miner?id=MINER_ID` - Individual miner stats
- `GET /api/health` - Health check endpoint

## Dashboard

A simple web dashboard is available at http://localhost:8081

## Performance Tuning

### System Requirements
- CPU: 2+ cores recommended
- RAM: 2GB minimum, 4GB recommended
- Disk: 10GB for data storage
- Network: 100Mbps+ for large pools

### Linux Optimizations
```bash
# Increase file descriptors
ulimit -n 65536

# TCP optimizations
echo "net.core.somaxconn = 1024" >> /etc/sysctl.conf
echo "net.ipv4.tcp_tw_reuse = 1" >> /etc/sysctl.conf
sysctl -p
```

### Node.js Optimizations
```bash
# Increase memory limit
NODE_OPTIONS="--max-old-space-size=4096" npm start

# Enable clustering (future feature)
CLUSTER_WORKERS=4 npm start
```

## Security

### Firewall Rules
```bash
# Allow Stratum
iptables -A INPUT -p tcp --dport 3333 -j ACCEPT

# Allow API (internal only)
iptables -A INPUT -p tcp --dport 8080 -s 10.0.0.0/8 -j ACCEPT

# Block everything else
iptables -A INPUT -j DROP
```

### SSL/TLS (Future Feature)
```bash
# Generate certificates
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365

# Enable in .env
SSL_ENABLED=true
SSL_KEY=./key.pem
SSL_CERT=./cert.pem
```

## Monitoring

Use the provided monitoring script:

```bash
# Linux/Mac
./scripts/monitor.sh

# Windows
scripts\monitor.bat
```

Or integrate with external monitoring:

### Prometheus Metrics (Future Feature)
```yaml
- job_name: 'otedama'
  static_configs:
    - targets: ['localhost:9090']
```

### Health Check
```bash
curl http://localhost:8080/api/health
```

## Troubleshooting

### Pool Won't Start
1. Check Bitcoin node is running and synced
2. Verify RPC credentials
3. Check ports aren't already in use
4. Review logs for errors

### Miners Can't Connect
1. Check firewall rules
2. Verify Stratum port is open
3. Check miner configuration
4. Test with telnet: `telnet localhost 3333`

### High Memory Usage
1. Reduce share buffer size in code
2. Enable more aggressive cleanup intervals
3. Monitor with: `node --inspect dist/main.js`

### Performance Issues
1. Run benchmarks: `npm run benchmark`
2. Check system resources
3. Profile with: `node --prof dist/main.js`
4. Analyze: `node --prof-process isolate-*.log`
