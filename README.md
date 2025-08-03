# Otedama - High-Performance Cryptocurrency Mining Software

[![Version](https://img.shields.io/badge/version-2.1.3-blue.svg)](https://github.com/shizukutanaka/Otedama)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Go Version](https://img.shields.io/badge/go-1.21+-red.svg)](https://golang.org)
[![Build Status](https://img.shields.io/badge/build-passing-brightgreen.svg)](https://github.com/shizukutanaka/Otedama/actions)

Otedama is a professional-grade cryptocurrency mining software designed for efficient and reliable mining operations. Built with Go for maximum performance, it supports CPU, GPU, and ASIC mining with a focus on simplicity, efficiency, and maintainability.

## 🚀 Features

### Core Mining Capabilities
- **Algorithm Support**: SHA256d (Bitcoin) with modular architecture for additional algorithms
- **Hardware Support**: Optimized for CPU, GPU (NVIDIA/AMD), and ASIC miners
- **Stratum Protocol**: Full Stratum v1 and v2 support with encryption
- **P2P Mining**: Decentralized mining pool functionality

### Performance & Efficiency
- **Lightweight Design**: Minimal resource usage with optimized memory management
- **Fast Startup**: Sub-second startup time with efficient initialization
- **Real-time Monitoring**: Built-in performance metrics without overhead
- **Auto-optimization**: Automatic hardware detection and optimization

### Enterprise Ready
- **High Availability**: Built-in failover and connection recovery
- **Security First**: TLS encryption, API authentication, rate limiting
- **Production Monitoring**: Prometheus metrics, health checks, logging
- **Easy Configuration**: Simple YAML-based configuration

## 📋 Requirements

- Go 1.21 or higher
- Linux, macOS, or Windows
- Mining hardware (CPU/GPU/ASIC)
- Network connection to mining pool

## 🛠️ Installation

### From Source

```bash
# Clone the repository
git clone https://github.com/shizukutanaka/Otedama.git
cd Otedama

# Build the binary
make build

# Install to system
make install
```

### Using Go Install

```bash
go install github.com/shizukutanaka/Otedama/cmd/otedama@latest
```

### Docker

```bash
docker pull ghcr.io/shizukutanaka/otedama:latest
docker run -d --name otedama -v ./config.yaml:/config.yaml ghcr.io/shizukutanaka/otedama:latest
```

## ⚡ Quick Start

### 1. Create Configuration

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml`:

```yaml
# Basic configuration
mining:
  algorithm: SHA256d
  threads: 0  # 0 = auto-detect

pool:
  url: "stratum+tcp://pool.example.com:3333"
  user: "your_wallet_address.worker_name"
  password: "x"

api:
  enabled: true
  listen: "0.0.0.0:8080"

monitoring:
  enabled: true
  prometheus: true
```

### 2. Start Mining

```bash
# Pool mining (recommended)
./otedama start

# Solo mining
./otedama solo

# P2P pool mode
./otedama p2p

# With custom config
./otedama start --config /path/to/config.yaml
```

### 3. Monitor Performance

```bash
# Check status
./otedama status

# View logs
tail -f logs/otedama.log

# API endpoint
curl http://localhost:8080/api/status
```

## 📊 Performance

Otedama v2.1.3 has been optimized for maximum efficiency:

- **Memory Usage**: 60% less than v2.1.2
- **Binary Size**: 50% smaller (~15MB)
- **Startup Time**: <500ms
- **CPU Overhead**: <1% for monitoring

## 🏗️ Architecture

```
otedama/
├── cmd/           # CLI applications
├── internal/      # Core implementation
│   ├── mining/    # Mining engine
│   ├── stratum/   # Stratum protocol
│   ├── api/       # REST/WebSocket API
│   ├── p2p/       # P2P networking
│   └── ...        # Other modules
└── config/        # Configuration
```

## 🔧 Advanced Configuration

### GPU Mining

```yaml
mining:
  gpu_enabled: true
  gpu_devices: [0, 1]  # Specific GPUs or [] for all
  intensity: 20        # 1-25, higher = more resources
```

### Multiple Pools

```yaml
pool:
  backup_pools:
    - url: "stratum+tcp://backup1.example.com:3333"
      user: "wallet.worker"
    - url: "stratum+tcp://backup2.example.com:3333"
      user: "wallet.worker"
```

### Security

```yaml
security:
  enable_tls: true
  cert_file: "/path/to/cert.pem"
  key_file: "/path/to/key.pem"
  
api:
  api_key: "your-secure-api-key"
  rate_limit: 100  # requests per minute
```

## 📡 API Reference

### REST Endpoints

- `GET /api/status` - Mining status
- `GET /api/stats` - Detailed statistics
- `GET /api/workers` - Worker information
- `POST /api/mining/start` - Start mining
- `POST /api/mining/stop` - Stop mining

### WebSocket

Connect to `ws://localhost:8080/api/ws` for real-time updates.

## 🐳 Deployment

### Docker Compose

```yaml
version: '3.8'
services:
  otedama:
    image: ghcr.io/shizukutanaka/otedama:latest
    volumes:
      - ./config.yaml:/config.yaml
    ports:
      - "8080:8080"
      - "3333:3333"
    restart: unless-stopped
```

### Kubernetes

```bash
kubectl apply -f k8s/
```

### Systemd

```bash
sudo cp scripts/otedama.service /etc/systemd/system/
sudo systemctl enable otedama
sudo systemctl start otedama
```

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Bitcoin Core developers for mining protocols
- Go community for excellent libraries
- All contributors and users of Otedama

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/shizukutanaka/Otedama/issues)
- **Discussions**: [GitHub Discussions](https://github.com/shizukutanaka/Otedama/discussions)
- **Wiki**: [Documentation](https://github.com/shizukutanaka/Otedama/wiki)

---

**⚠️ Important**: Cryptocurrency mining consumes significant computational resources and electricity. Please ensure you understand the costs and environmental impact before mining.