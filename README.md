# Otedama - Enterprise P2P Mining Pool & Mining Software

**Version**: 2.1.5  
**License**: MIT  
**Go Version**: 1.21+  
**Architecture**: Microservices-ready with P2P Pool  
**Release Date**: August 6, 2025

Otedama is an enterprise-grade P2P mining pool and mining software engineered for maximum efficiency and reliability. Built following principles from John Carmack (performance), Robert C. Martin (clean architecture), and Rob Pike (simplicity), it supports comprehensive CPU/GPU/ASIC mining with national-level scalability.

## Architecture Overview

### P2P Mining Pool
- **Decentralized Pool Management**: Distributed mining pool with automatic failover
- **Reward Distribution**: Advanced PPS/PPLNS algorithms with multi-currency support
- **Federation Protocol**: Inter-pool communication for enhanced resilience
- **National-Level Monitoring**: Enterprise monitoring suitable for government deployment

### Mining Capabilities
- **Multi-Algorithm**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Universal Hardware**: Optimized CPU, GPU (CUDA/OpenCL), and ASIC support
- **Advanced Stratum**: Full v1/v2 with extensions for high-performance miners
- **Zero-Copy Optimizations**: Cache-aware data structures and NUMA-aware memory

### Enterprise Features
- **Production Ready**: Docker/Kubernetes deployment with auto-scaling
- **Enterprise Security**: DDoS protection, rate limiting, comprehensive audit
- **High Availability**: Multi-node setup with automatic failover
- **Real-time Analytics**: WebSocket API with live dashboard integration

## System Requirements

- Go 1.21 or higher
- Linux, macOS, or Windows
- Mining hardware (CPU/GPU/ASIC)
- Network connection to mining pool

## Installation

### From Source

```bash
# Build from source directory
cd Otedama

# Build the binary
make build

# Install to system
make install
```

### Using Go Build

```bash
go build ./cmd/otedama
```

### Docker Production

```bash
# Production deployment
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Deploy complete stack
kubectl apply -f k8s/
```

## Quick Start Guide

### 1. Configuration

```yaml
# Production configuration with P2P pool
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Auto-detect
    priority: "normal"
  
  gpu:
    devices: [] # Auto-detect all
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Auto-discover
    poll_interval: 5s

pool:
  enable: true
  address: "0.0.0.0:3333"
  max_connections: 10000
  fee_percentage: 1.0
  rewards:
    system: "PPLNS"
    window: 2h

stratum:
  enable: true
  address: "0.0.0.0:3333"
  max_workers: 10000
  
api:
  enable: true
  address: "0.0.0.0:8080"
  auth:
    enabled: true
    token_expiry: 24h

monitoring:
  metrics:
    enabled: true
    address: "0.0.0.0:9090"
  health:
    enabled: true
    address: "0.0.0.0:8081"
```

### 2. Deployment Options

```bash
# Development
./otedama serve --config config.yaml

# Production Docker
docker-compose -f docker-compose.production.yml up -d

# Enterprise Kubernetes
kubectl apply -f k8s/

# Manual production deployment
sudo ./scripts/production-deploy.sh
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

## Performance Metrics

Otedama has been optimized for maximum efficiency:

- **Memory Usage**: Optimized for minimal memory footprint
- **Binary Size**: Compact size (~15MB)
- **Startup Time**: <500ms
- **CPU Overhead**: <1% for monitoring

## Project Structure

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

## Advanced Configuration

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

## API Reference

### REST Endpoints

- `GET /api/status` - Mining status
- `GET /api/stats` - Detailed statistics
- `GET /api/workers` - Worker information
- `POST /api/mining/start` - Start mining
- `POST /api/mining/stop` - Stop mining

### WebSocket

Connect to `ws://localhost:8080/api/ws` for real-time updates.

## Deployment

### Docker Compose

```yaml
version: '3.8'
services:
  otedama:
    build: .
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

## Contributing

Contributions are welcome! Please follow standard development practices:

1. Create your feature branch
2. Make your changes
3. Test thoroughly
4. Submit for review

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Bitcoin Core developers for mining protocols
- Go community for excellent libraries
- All contributors and users of Otedama

## Support

- Check the documentation in the `docs/` directory
- Review configuration examples in `config.example.yaml`
- Consult the API documentation at `/api/docs` when running

## Donations

If you find Otedama useful, please consider supporting the development:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Your support helps maintain and improve Otedama!

---

**Important**: Cryptocurrency mining consumes significant computational resources and electricity. Please ensure you understand the costs and environmental impact before mining.