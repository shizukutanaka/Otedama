# Otedama - P2P Mining Pool Software Usage Guide

## Table of Contents
1. [Installation](#installation)
2. [Configuration](#configuration)
3. [Running Otedama](#running-otedama)
4. [Mining Operations](#mining-operations)
5. [Pool Management](#pool-management)
6. [Monitoring](#monitoring)
7. [Troubleshooting](#troubleshooting)

## Installation

### System Requirements
- Operating System: Linux, Windows, macOS
- RAM: Minimum 4GB, Recommended 8GB+
- Storage: 50GB+ free space
- Network: Stable internet connection

### Quick Install
```bash
# Download latest release
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64

# Or build from source
git clone https://github.com/otedama/otedama.git
cd otedama
go build -o otedama cmd/otedama/main.go
```

## Configuration

### Basic Configuration
Create `config.yaml`:
```yaml
mining:
  algorithm: sha256d
  threads: 4
  intensity: 10

pool:
  url: stratum+tcp://pool.example.com:3333
  wallet_address: YOUR_WALLET_ADDRESS
  worker_name: worker1

p2p:
  enabled: true
  listen_addr: 0.0.0.0:19333
  max_peers: 50
```

### Advanced Settings
```yaml
hardware:
  cpu:
    enabled: true
    threads: 8
  gpu:
    enabled: true
    devices: [0, 1]
  asic:
    enabled: false

monitoring:
  enabled: true
  listen_addr: 0.0.0.0:8080
  prometheus_enabled: true
```

## Running Otedama

### Solo Mining
```bash
./otedama --solo --algorithm sha256d --threads 8
```

### Pool Mining
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet YOUR_WALLET --worker worker1
```

### P2P Pool Mode
```bash
./otedama --p2p --listen 0.0.0.0:19333 --bootstrap node1.example.com:19333,node2.example.com:19333
```

### Docker Deployment
```bash
docker run -d \
  --name otedama \
  -p 19333:19333 \
  -p 8080:8080 \
  -v ./config.yaml:/config.yaml \
  otedama/otedama:latest
```

## Mining Operations

### Supported Algorithms
- SHA256d (Bitcoin)
- Scrypt (Litecoin)
- Ethash (Ethereum Classic)
- KawPow (Ravencoin)
- RandomX (Monero)
- Autolykos2 (Ergo)

### Hardware Optimization
```bash
# CPU mining with SIMD optimization
./otedama --cpu --optimize simd

# GPU mining with multiple devices
./otedama --gpu --devices 0,1,2,3

# ASIC mining
./otedama --asic --model antminer-s19
```

### Performance Tuning
```bash
# Adjust intensity (1-20)
./otedama --intensity 15

# Memory optimization
./otedama --memory-pool 2048

# Network optimization
./otedama --low-latency --max-connections 100
```

## Pool Management

### Starting Pool Server
```bash
./otedama pool --listen 0.0.0.0:3333 --fee 1.0 --min-payout 0.001
```

### Worker Management
```bash
# List workers
./otedama workers list

# Add worker
./otedama workers add --name worker1 --wallet ADDRESS

# Remove worker
./otedama workers remove worker1

# View worker stats
./otedama workers stats worker1
```

### Payout Configuration
```yaml
pool:
  payout_scheme: PPLNS  # or PPS, PROP
  payout_interval: 24h
  min_payout: 0.001
  fee_percent: 1.0
```

## Monitoring

### Web Dashboard
Access at `http://localhost:8080`

Features:
- Real-time hashrate graphs
- Worker statistics
- Pool performance metrics
- Payout history

### Command Line Monitoring
```bash
# View current stats
./otedama stats

# Watch real-time
./otedama monitor

# Export metrics
./otedama metrics export --format json
```

### Prometheus Integration
```yaml
monitoring:
  prometheus_enabled: true
  prometheus_port: 9090
```

### Alerts Configuration
```yaml
alerts:
  email:
    enabled: true
    smtp_server: smtp.gmail.com:587
    from: alerts@example.com
    to: admin@example.com
  thresholds:
    min_hashrate: 1000000
    max_temperature: 85
    min_workers: 5
```

## Troubleshooting

### Common Issues

#### Connection Problems
```bash
# Test pool connection
./otedama test --pool stratum+tcp://pool.example.com:3333

# Debug network
./otedama --debug --verbose
```

#### Performance Issues
```bash
# Run benchmark
./otedama benchmark --duration 60

# Profile CPU usage
./otedama --profile cpu.prof
```

#### Hardware Detection
```bash
# Scan hardware
./otedama hardware scan

# Test specific device
./otedama hardware test --gpu 0
```

### Log Files
```bash
# View logs
tail -f /var/log/otedama/otedama.log

# Change log level
./otedama --log-level debug
```

### Recovery Mode
```bash
# Start in safe mode
./otedama --safe-mode

# Reset configuration
./otedama --reset-config

# Database repair
./otedama db repair
```

## API Reference

### REST API
```bash
# Get status
curl http://localhost:8080/api/status

# Get workers
curl http://localhost:8080/api/workers

# Submit share
curl -X POST http://localhost:8080/api/submit \
  -H "Content-Type: application/json" \
  -d '{"worker":"worker1","nonce":"12345678"}'
```

### WebSocket API
```javascript
const ws = new WebSocket('ws://localhost:8080/ws');
ws.on('message', (data) => {
  console.log('Received:', data);
});
```

## Security

### Authentication
```yaml
security:
  auth_enabled: true
  jwt_secret: YOUR_SECRET_KEY
  api_keys:
    - key: API_KEY_1
      permissions: [read, write]
```

### SSL/TLS
```yaml
security:
  tls_enabled: true
  cert_file: /path/to/cert.pem
  key_file: /path/to/key.pem
```

### Firewall Rules
```bash
# Allow Stratum
iptables -A INPUT -p tcp --dport 3333 -j ACCEPT

# Allow P2P
iptables -A INPUT -p tcp --dport 19333 -j ACCEPT

# Allow monitoring
iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
```

## Support

- GitHub: https://github.com/otedama/otedama
