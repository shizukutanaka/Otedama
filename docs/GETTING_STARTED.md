# Getting Started with Otedama

Welcome to Otedama, a high-performance P2P mining pool software supporting CPU, GPU, and ASIC mining.

## Table of Contents

- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Installation Methods](#installation-methods)
- [Configuration](#configuration)
- [Running Your First Node](#running-your-first-node)
- [Connecting Miners](#connecting-miners)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)

## Requirements

### System Requirements

- **Operating System**: Linux (Ubuntu 20.04+, CentOS 8+), macOS 11+, Windows 10+
- **CPU**: 4+ cores recommended
- **RAM**: 8GB minimum, 16GB recommended
- **Storage**: 50GB+ SSD recommended
- **Network**: Stable internet connection with open ports

### Software Requirements

- Go 1.20+ (for building from source)
- PostgreSQL 14+
- Redis 6+
- Docker (optional, for containerized deployment)

## Quick Start

The fastest way to get started with Otedama:

```bash
# Download the latest release
curl -sSL https://github.com/otedama/otedama/releases/latest/download/otedama-linux-amd64.tar.gz | tar xz

# Create configuration
./otedama init

# Start the node
./otedama start
```

## Installation Methods

### 1. Binary Installation

Download pre-built binaries from our [releases page](https://github.com/otedama/otedama/releases).

```bash
# Linux/macOS
wget https://github.com/otedama/otedama/releases/latest/download/otedama-$(uname -s)-$(uname -m).tar.gz
tar -xzf otedama-*.tar.gz
sudo mv otedama /usr/local/bin/

# Windows
# Download the .exe file from releases and add to PATH
```

### 2. Package Managers

#### Debian/Ubuntu (APT)
```bash
curl -sSL https://otedama.io/install/apt-key.gpg | sudo apt-key add -
echo "deb https://otedama.io/apt stable main" | sudo tee /etc/apt/sources.list.d/otedama.list
sudo apt update
sudo apt install otedama
```

#### Red Hat/CentOS (YUM)
```bash
sudo rpm --import https://otedama.io/install/rpm-key.gpg
sudo curl -o /etc/yum.repos.d/otedama.repo https://otedama.io/install/otedama.repo
sudo yum install otedama
```

#### macOS (Homebrew)
```bash
brew tap otedama/tap
brew install otedama
```

### 3. Docker Installation

```bash
# Pull the latest image
docker pull ghcr.io/otedama/otedama:latest

# Run with Docker Compose
curl -O https://raw.githubusercontent.com/otedama/otedama/master/docker-compose.yml
docker-compose up -d
```

### 4. Building from Source

```bash
# Clone the repository
git clone https://github.com/otedama/otedama.git
cd otedama

# Build
make build

# Install
sudo make install
```

## Configuration

### Initial Setup

Run the initialization wizard:

```bash
otedama init
```

This will create a default configuration file at `~/.otedama/config.yaml`.

### Manual Configuration

Edit the configuration file:

```yaml
# Server Configuration
server:
  host: "0.0.0.0"
  port: 8080

# Stratum Server
stratum:
  host: "0.0.0.0"
  port: 3333
  difficulty: 0.001

# Pool Settings
pool:
  fee: 1.0  # 1% pool fee
  payoutThreshold: 0.001
  payoutInterval: 3600  # 1 hour

# Database
database:
  host: "localhost"
  port: 5432
  name: "otedama"
  user: "otedama"
  password: "your-secure-password"

# Mining Algorithms
mining:
  algorithms:
    - sha256
    - scrypt
    - ethash
```

### Environment Variables

You can override configuration with environment variables:

```bash
export OTEDAMA_SERVER_PORT=8080
export OTEDAMA_DATABASE_PASSWORD=your-password
export OTEDAMA_POOL_FEE=0.5
```

## Running Your First Node

### 1. Start Dependencies

```bash
# PostgreSQL
docker run -d --name postgres \
  -e POSTGRES_DB=otedama \
  -e POSTGRES_USER=otedama \
  -e POSTGRES_PASSWORD=password \
  -p 5432:5432 \
  postgres:15

# Redis
docker run -d --name redis \
  -p 6379:6379 \
  redis:7-alpine
```

### 2. Initialize Database

```bash
otedama db migrate
```

### 3. Start the Node

```bash
# Foreground
otedama start

# Background (systemd)
sudo systemctl start otedama
sudo systemctl enable otedama
```

### 4. Verify Operation

```bash
# Check status
otedama status

# View logs
otedama logs -f

# Health check
curl http://localhost:8080/health
```

## Connecting Miners

### CPU Mining

```bash
# Using built-in miner
otedama mine --algorithm sha256 --threads 4

# Using external miner (cpuminer)
cpuminer -a sha256d -o stratum+tcp://localhost:3333 -u YOUR_WALLET_ADDRESS -p x
```

### GPU Mining

```bash
# NVIDIA (T-Rex Miner)
t-rex -a ethash -o stratum+tcp://localhost:3333 -u YOUR_WALLET_ADDRESS -p x

# AMD (TeamRedMiner)
teamredminer -a ethash -o stratum+tcp://localhost:3333 -u YOUR_WALLET_ADDRESS -p x
```

### ASIC Mining

Configure your ASIC miner with:
- **Pool URL**: `stratum+tcp://your-server:3333`
- **Username**: Your wallet address
- **Password**: `x` (or worker name)

## Monitoring

### Web Dashboard

Access the web dashboard at `http://localhost:8080`

Features:
- Real-time hashrate charts
- Worker statistics
- Payout history
- Network status

### Metrics

Prometheus metrics available at `http://localhost:9090/metrics`

```bash
# Example metrics
otedama_pool_hashrate_total
otedama_pool_workers_active
otedama_pool_shares_valid_total
otedama_pool_blocks_found_total
```

### Command Line

```bash
# Pool statistics
otedama pool stats

# Worker information
otedama worker list

# Recent blocks
otedama blocks list --limit 10
```

## Troubleshooting

### Common Issues

#### 1. Cannot Connect to Database

```bash
# Check PostgreSQL status
sudo systemctl status postgresql

# Test connection
psql -h localhost -U otedama -d otedama

# Check logs
tail -f /var/log/postgresql/postgresql-*.log
```

#### 2. Miners Cannot Connect

```bash
# Check if port is open
sudo netstat -tlnp | grep 3333

# Test stratum connection
telnet localhost 3333

# Check firewall
sudo ufw status
sudo ufw allow 3333/tcp
```

#### 3. High Memory Usage

```bash
# Adjust worker limits in config
mining:
  maxWorkers: 1000
  workerTimeout: 300

# Tune PostgreSQL
shared_buffers = 256MB
effective_cache_size = 1GB
```

### Debug Mode

Run in debug mode for detailed logging:

```bash
otedama start --debug
```

### Getting Help

- **Documentation**: https://docs.otedama.io
- **Community Forum**: https://forum.otedama.io
- **Discord**: https://discord.gg/otedama
- **GitHub Issues**: https://github.com/otedama/otedama/issues

## Next Steps

- [API Documentation](./API_DOCUMENTATION.md) - Integrate with Otedama
- [Deployment Guide](./DEPLOYMENT_GUIDE.md) - Production deployment
- [Architecture Overview](./ARCHITECTURE.md) - Technical deep dive
- [Contributing Guide](../CONTRIBUTING.md) - Join development