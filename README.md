# Otedama P2P Mining Pool v2.1.9

A high-performance, secure, and scalable P2P mining pool system with advanced optimization capabilities.

## Features

### Core Capabilities
- **Multi-Algorithm Support**: SHA256d, Scrypt, Ethash, RandomX, and more
- **Hardware Support**: CPU, GPU (NVIDIA/AMD), and ASIC mining
- **P2P Network**: Decentralized peer-to-peer architecture
- **Auto-Optimization**: Automatic performance tuning and power management
- **Security-First**: Built with enterprise-grade security measures

### Security Features
- Rate limiting and DDoS protection
- Session management with CSRF protection
- Input validation and sanitization
- Secure password hashing (bcrypt)
- TLS/SSL support
- IP-based access control

### Performance Optimizations
- Hardware-accelerated mining algorithms
- Memory pool optimization
- Automatic difficulty adjustment
- Load balancing across devices
- Real-time performance monitoring

## Quick Start

### Requirements
- Go 1.21 or higher
- PostgreSQL 14+ or SQLite3
- Redis (optional, for caching)

### Installation

```bash
# Clone the repository
git clone https://github.com/otedama/otedama.git
cd otedama

# Build the application
go build -o otedama ./cmd/otedama

# Run with default configuration
./otedama
```

### Configuration

Create a `config.yaml` file:

```yaml
mining:
  algorithm: sha256d
  auto_start: true
  cpu:
    enabled: true
    threads: -1  # Auto-detect
  gpu:
    enabled: false

api:
  enable: true
  address: ":8080"
  
stratum:
  enabled: true
  pools:
    - url: "stratum+tcp://pool.example.com:3333"
      user: "your_wallet_address"
      password: "x"
```

## API Endpoints

- `GET /health` - Health check
- `GET /api/mining/status` - Mining status
- `POST /api/mining/start` - Start mining
- `POST /api/mining/stop` - Stop mining
- `GET /api/stats` - Pool statistics

## Docker Support

```bash
# Build Docker image
docker build -t otedama:v2.1.9 .

# Run with Docker Compose
docker-compose up -d
```

## Development

### Project Structure
```
otedama/
├── cmd/           # Application entrypoints
├── internal/      # Internal packages
│   ├── mining/    # Mining engine
│   ├── p2p/       # P2P networking
│   ├── api/       # REST API
│   └── security/  # Security components
├── config/        # Configuration files
└── web/           # Web interface
```

### Testing
```bash
# Run unit tests
go test ./...

# Run benchmarks
go test -bench=. ./internal/mining

# Run with race detector
go test -race ./...
```

## License

MIT License - see LICENSE file for details

## Support

For issues and feature requests, please use the GitHub issue tracker.

## Version History

See CHANGELOG.md for detailed version history.