# Otedama Documentation

Welcome to the official Otedama documentation. This guide provides comprehensive information for setting up, configuring, and operating Otedama mining software.

## Documentation Index

### Getting Started
- [Setup Guide](./SETUP_GUIDE.md) - Complete installation and configuration guide
- [Quick Start](../../README.md) - Get mining in 5 minutes

### Technical Documentation
- [API Documentation](./API.md) - REST and WebSocket API reference
- [Configuration Reference](./CONFIG_REFERENCE.md) - All configuration options explained
- [Hardware Optimization](./HARDWARE_OPTIMIZATION.md) - Maximize your mining performance

### Operation Guides
- [Mining Strategies](./MINING_STRATEGIES.md) - Pool vs Solo, profit switching
- [Monitoring & Analytics](./MONITORING.md) - Dashboard and metrics
- [Troubleshooting](./TROUBLESHOOTING.md) - Common issues and solutions

### Advanced Topics
- [Zero-Knowledge Proof Authentication](./ZKP_AUTH.md) - Privacy-preserving authentication
- [P2P Network Architecture](./P2P_ARCHITECTURE.md) - Distributed pool design
- [Security Best Practices](./SECURITY.md) - Keeping your operation secure
- [Scaling Guide](./SCALING.md) - From hobby to enterprise

### Development
- [Contributing](./CONTRIBUTING.md) - How to contribute to Otedama
- [Plugin Development](./PLUGINS.md) - Extend Otedama functionality
- [Testing Guide](./TESTING.md) - Running and writing tests

## Quick Links

- **Support**: Submit issues via GitHub Issues
- **Community**: Join our community forums
- **Updates**: Check releases page for latest versions

## System Requirements

**Minimum:**
- CPU: x64 processor (2+ cores)
- RAM: 4GB
- Storage: 20GB SSD
- OS: Ubuntu 20.04+, Windows 10+, macOS 11+
- Node.js: v18.0.0+

**Recommended:**
- CPU: 8+ cores
- GPU: NVIDIA RTX 3060+ or AMD RX 6600+
- RAM: 16GB+
- Storage: 100GB NVMe SSD

## Supported Algorithms

- SHA-256 (Bitcoin)
- Scrypt (Litecoin)
- Ethash (Ethereum Classic)
- RandomX (Monero)
- KawPow (Ravencoin)
- ProgPoW (ASIC-resistant)

## Key Features

### Privacy First
- Zero-Knowledge Proof authentication
- No personal data collection
- End-to-end encryption

### Performance
- Hardware auto-detection and optimization
- Multi-threaded operations
- GPU acceleration support
- Memory-efficient design

### Reliability
- Automatic failover
- Self-healing systems
- 99.99% uptime design
- Comprehensive monitoring

### Scalability
- Support for 10M+ connections
- Horizontal scaling
- Load balancing
- Multi-region deployment

## Getting Help

1. **Documentation**: Start with the relevant guide above
2. **Diagnostics**: Run `npm run diagnose` for system check
3. **Logs**: Check `logs/otedama.log` for detailed information
4. **Community**: Ask questions in community forums
5. **Issues**: Report bugs via GitHub Issues

## License

Otedama is open source software released under the MIT License. See [LICENSE](../../LICENSE) for details.