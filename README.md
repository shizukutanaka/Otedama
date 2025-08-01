# Otedama - High-Performance P2P Mining Pool Software

## Overview

Otedama is a professional-grade cryptocurrency mining software designed for reliable operations with support for CPU, GPU, and ASIC mining. Built with advanced authentication mechanisms including Zero-Knowledge Proof (ZKP), it provides secure and efficient mining capabilities suitable for enterprise deployments.

## Key Features

### Core Mining Capabilities
- **Multi-Hardware Support**: Optimized algorithms for CPU (x86, ARM), GPU (NVIDIA, AMD), and ASIC hardware
- **P2P Mining Pool**: Decentralized architecture with automatic failover and load balancing
- **Algorithm Auto-Switching**: Automatic profitability-based algorithm switching
- **Zero-Knowledge Proof**: Privacy-preserving authentication without KYC requirements

### Advanced Features
- **Hardware Acceleration**: AES-NI, SHA extensions, and GPU-accelerated cryptography
- **Container Support**: Docker deployment for scalable operations
- **Real-Time Analytics**: Comprehensive dashboard with performance metrics
- **Advanced Difficulty Adjustment**: PID-controlled difficulty with outlier removal
- **Multi-Mode Authentication**: Static, Dynamic, Database, Wallet, and ZKP authentication

### Enterprise Features
- **Multi-User Management**: Role-based access control with audit logging
- **High-Performance Networking**: Optimized protocol implementation
- **Comprehensive Monitoring**: Health checks, metrics, and alerting
- **Automatic Failover**: P2P pool with automatic node discovery
- **Security Hardening**: DDoS protection, rate limiting, and access control

## System Requirements

### Minimum Requirements
- CPU: 4 cores (x86_64 or ARM64)
- RAM: 8GB
- Storage: 50GB SSD
- Network: 100Mbps
- OS: Linux, Windows 10+, macOS 11+

### Recommended Requirements
- CPU: 16+ cores with AES-NI support
- RAM: 32GB+ ECC memory
- Storage: 500GB NVMe SSD
- Network: 1Gbps+ with low latency
- GPU: NVIDIA RTX 3060+ or AMD RX 6600+

## Installation

### Binary Installation (Recommended)

Download the latest release for your platform:

```bash
# Linux
wget https://github.com/shizukutanaka/Otedama/releases/latest/download/otedama-linux-amd64
chmod +x otedama-linux-amd64
sudo mv otedama-linux-amd64 /usr/local/bin/otedama

# Windows
# Download otedama-windows-amd64.exe from releases page

# macOS
wget https://github.com/shizukutanaka/Otedama/releases/latest/download/otedama-darwin-amd64
chmod +x otedama-darwin-amd64
sudo mv otedama-darwin-amd64 /usr/local/bin/otedama
```

### Build from Source

Prerequisites:
- Go 1.21+
- GCC/Clang with C++17 support
- CUDA Toolkit 12.0+ (for GPU mining)
- Git

```bash
# Clone repository
git clone https://github.com/shizukutanaka/Otedama.git
cd Otedama

# Install dependencies
go mod download

# Build with all features
make build-full

# Or build with specific features
make build-cpu      # CPU mining only
make build-gpu      # GPU mining support
make build-enterprise # All enterprise features
```

## Quick Start Guide

### 1. Initial Setup

```bash
# Generate configuration
otedama init

# This creates:
# - config.yaml (main configuration)
# - wallet.key (ZKP wallet key)
# - peers.json (P2P bootstrap nodes)
```

### 2. Configure Mining

Edit `config.yaml`:

```yaml
# Basic mining configuration
mining:
  mode: "auto"              # auto, manual, profit-switching
  algorithms:
    - name: "ethash"
      enabled: true
      intensity: 80         # 1-100
    - name: "randomx"
      enabled: true
      threads: 8
    - name: "kawpow"
      enabled: true
      gpu_only: true

# Hardware configuration
hardware:
  cpu:
    threads: 0              # 0 = auto-detect
    affinity: true          # Pin threads to cores
    huge_pages: true        # Enable huge pages
  gpu:
    - index: 0
      enabled: true
      memory_clock: 2100
      core_clock: 1800
      power_limit: 220
      fan_speed: "auto"     # auto, 0-100
  asic:
    enabled: false
    devices: []

# P2P pool settings
p2p:
  enabled: true
  mode: "hybrid"            # pure-p2p, hybrid, federated
  listen: "0.0.0.0:3333"
  max_peers: 100
  bootstrap_nodes:
    - "seed1.otedama.network:3333"
    - "seed2.otedama.network:3333"
  
# ZKP authentication
zkp:
  enabled: true
  identity_proof: true      # Prove miner identity
  compliance_proof: false   # Optional compliance proofs
  reputation_threshold: 0.8 # Minimum reputation score

# Performance optimization
optimization:
  auto_tuning: true         # AI-powered auto-tuning
  profit_switching: true    # Switch algorithms by profit
  power_efficiency: "balanced" # performance, balanced, efficiency
  
# Advanced features
features:
  blockchain_integration: true
  smart_payouts: true
  renewable_energy: false
  container_mode: false
  hardware_monitoring: true
  predictive_maintenance: true
```

### 3. Start Mining

```bash
# Start with default config
otedama start

# Start with specific config
otedama start --config custom-config.yaml

# Start in daemon mode
otedama start --daemon --log-file otedama.log

# Start with performance profiling
otedama start --profile --profile-port 6060
```

## Operating Modes

### Solo Mining
Mine directly to your wallet without a pool:

```bash
otedama solo --wallet YOUR_WALLET --algorithm ethash --rpc http://node.example.com:8545
```

### Pool Mining
Connect to traditional mining pools:

```bash
otedama pool --url stratum+tcp://pool.example.com:3333 --wallet YOUR_WALLET --worker worker1
```

### P2P Pool Mining
Join or create a P2P mining pool:

```bash
# Join existing P2P pool
otedama p2p join --bootstrap peer1.example.com:3333,peer2.example.com:3333

# Create new P2P pool
otedama p2p create --name "MyPool" --fee 1.0 --min-payout 0.1
```

### Enterprise Deployment
Deploy at scale with orchestration:

```bash
# Generate Kubernetes manifests
otedama deploy k8s --replicas 100 --namespace mining

# Deploy with Docker Compose
otedama deploy compose --scale 50

# Deploy with auto-scaling
otedama deploy k8s --autoscale --min 10 --max 1000 --target-cpu 80
```

## Management Interface

### Web Dashboard
Access the web dashboard at `http://localhost:8080`

Features:
- Real-time hashrate charts
- Worker management
- Temperature monitoring
- Profit calculator
- Alert configuration

### REST API

```bash
# Get mining statistics
curl http://localhost:8080/api/v1/stats

# Manage workers
curl http://localhost:8080/api/v1/workers
curl -X POST http://localhost:8080/api/v1/workers/pause/gpu-0

# Configure algorithms
curl -X PUT http://localhost:8080/api/v1/algorithms/ethash \
  -d '{"enabled": true, "intensity": 90}'

# User management
curl -X POST http://localhost:8080/api/v1/users \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"username": "operator1", "role": "operator"}'
```

### Command Line Interface

```bash
# Show status
otedama status

# List workers
otedama workers list

# Pause/resume mining
otedama pause
otedama resume

# Switch algorithm
otedama algo switch randomx

# Check profits
otedama profit --period 24h

# Export statistics
otedama stats export --format csv --output stats.csv
```

## Performance Optimization

### CPU Optimization
```bash
# Enable huge pages (Linux)
sudo sysctl -w vm.nr_hugepages=1280

# Set CPU governor
sudo cpupower frequency-set -g performance

# Configure NUMA affinity
otedama tune cpu --numa-node 0 --threads 32
```

### GPU Optimization
```bash
# Auto-tune GPU settings
otedama tune gpu auto

# Manual GPU tuning
otedama tune gpu --device 0 --mem-clock 2150 --core-clock 1850 --power 230

# Enable GPU monitoring
otedama monitor gpu --interval 1s --alert-temp 85
```

### Network Optimization
```bash
# Configure protocol optimization
otedama tune network --tcp-nodelay --quick-ack --buffer-size 4MB

# Optimize connection pooling
otedama tune network --pool-size 100 --keepalive 30s
```

## Advanced Features

### Profit Switching
```bash
# Enable automatic profit switching
otedama profit enable --interval 5m --threshold 10

# Configure supported coins
otedama profit add-coin --symbol BTC --algo sha256 --pool pool.example.com

# View profitability analysis
otedama profit analyze --period 24h
```

### Zero-Knowledge Proof Authentication
```bash
# Generate ZKP credentials
otedama zkp generate --identity worker1

# Enable ZKP authentication
otedama config set auth.mode zkp

# Verify ZKP status
otedama zkp status
```

### Performance Monitoring
```bash
# Enable comprehensive monitoring
otedama monitor enable --interval 1s

# Configure alerting
otedama monitor alert --cpu 90 --gpu-temp 85 --memory 95

# Export metrics
otedama monitor export --prometheus --port 9090
```

## Security

### ZKP Authentication
```bash
# Generate ZKP identity
otedama zkp generate-identity

# Prove identity without revealing
otedama zkp prove --identity wallet.key

# Verify reputation
otedama zkp verify-reputation --min-score 0.9
```

### Access Control
```bash
# Create roles
otedama rbac create-role operator --permissions "mining.*,monitoring.view"
otedama rbac create-role admin --permissions "*"

# Assign users
otedama rbac assign user1 operator
otedama rbac assign admin1 admin

# Enable MFA
otedama security mfa enable --type totp
```

## Monitoring and Alerts

### Prometheus Metrics
Metrics available at `http://localhost:9090/metrics`:
- `otedama_hashrate_total`
- `otedama_shares_accepted`
- `otedama_temperature_celsius`
- `otedama_power_watts`
- `otedama_earnings_total`

### Alert Configuration
```yaml
alerts:
  - name: "High Temperature"
    condition: "temperature > 85"
    action: "throttle"
    notify: ["email", "webhook"]
  
  - name: "Low Hashrate"
    condition: "hashrate < expected * 0.9"
    action: "restart"
    cooldown: 5m
  
  - name: "Hardware Failure"
    condition: "device.status == 'error'"
    action: "failover"
    notify: ["sms", "email"]
```

## Troubleshooting

### Diagnostic Commands
```bash
# Run diagnostics
otedama diagnose

# Check hardware
otedama hardware test

# Verify configuration
otedama config validate

# Analyze logs
otedama logs analyze --errors --warnings

# Generate debug report
otedama debug report --output debug-report.zip
```

### Common Issues

1. **Low Hashrate**
```bash
# Check for throttling
otedama diagnose throttle

# Reset to defaults
otedama reset gpu --device 0

# Run benchmark
otedama benchmark --algorithm all
```

2. **Connection Issues**
```bash
# Test connectivity
otedama network test

# Reset P2P connections
otedama p2p reset

# Use fallback nodes
otedama p2p fallback
```

3. **Memory Errors**
```bash
# Check memory usage
otedama memory check

# Enable swap (Linux)
sudo fallocate -l 32G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

## Best Practices

### Production Deployment
1. Use redundant power supplies
2. Implement proper cooling (ambient < 25°C)
3. Monitor 24/7 with alerts
4. Regular maintenance schedule
5. Automated failover configuration
6. Backup configuration and wallets

### Security Hardening
1. Enable firewall rules
2. Use strong authentication
3. Regular security updates
4. Audit logs monitoring
5. Network isolation
6. Encrypted communications

### Performance Tuning
1. Profile before optimizing
2. Monitor thermals constantly
3. Use quality PSUs (80+ Gold)
4. Regular driver updates
5. Clean hardware monthly
6. Document all changes

## Support

### Documentation
- User Guide: https://github.com/shizukutanaka/Otedama/wiki/User-Guide
- API Reference: https://github.com/shizukutanaka/Otedama/wiki/API-Reference
- Architecture: https://github.com/shizukutanaka/Otedama/wiki/Architecture

### Community
- GitHub Issues: https://github.com/shizukutanaka/Otedama/issues
- GitHub Discussions: https://github.com/shizukutanaka/Otedama/discussions

### Enterprise Support
- Contact via GitHub Issues with [enterprise] tag
- SLA: 24/7 support with 1-hour response
- Training: Available on request

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

Licensed under the MIT License. See [LICENSE](LICENSE) for details.

## Disclaimer

Cryptocurrency mining involves financial risk. Users are responsible for:
- Electricity costs and profitability calculations
- Legal compliance in their jurisdiction  
- Hardware warranty implications
- Tax obligations on mining rewards

Always conduct thorough research before mining.