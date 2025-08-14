# Otedama

High-performance P2P mining pool and mining software supporting CPU, GPU, and ASIC hardware.

## Features

### Core Capabilities
- **Multi-Algorithm Support**: SHA256, Scrypt, Ethash, KawPow, RandomX, Autolykos2, and more
- **Hardware Optimization**: Automatic detection and optimization for CPU, GPU, ASIC, and FPGA
- **P2P Network**: Decentralized peer-to-peer mining pool with DHT-based discovery
- **Zero-Allocation Design**: Memory pool management for maximum performance
- **Enterprise-Grade**: Production-ready with comprehensive error recovery and monitoring

### Mining Features
- **Smart Algorithm Switching**: Automatic profit-based algorithm switching
- **Hardware Auto-Detection**: Detects and configures optimal settings for available hardware
- **Stratum V1/V2 Support**: Compatible with all major mining pools
- **Solo Mining**: Built-in blockchain client for solo mining
- **Pool Mining**: Connect to any Stratum-compatible pool

### Performance Optimizations
- **SIMD Instructions**: AVX2, AVX512, SSE4, NEON support
- **Cache-Aware Design**: Optimized for L1/L2/L3 cache utilization
- **Lock-Free Data Structures**: Ring buffers and atomic operations for minimal contention
- **Batch Processing**: Efficient batch mining for reduced overhead
- **Memory Pooling**: Reusable buffers to eliminate GC pressure

## Quick Start

### Installation

#### Binary Release
Download the latest release for your platform from the releases page.

#### Build from Source
```bash
# Clone repository
git clone https://github.com/shizukutanaka/Otedama.git
cd Otedama

# Build
go build -o otedama cmd/otedama/main.go

# Run
./otedama
```

### Basic Usage

#### Solo Mining
```bash
# Mine Bitcoin with CPU
./otedama --algo sha256d --solo --wallet YOUR_BTC_ADDRESS

# Mine Ethereum with GPU
./otedama --algo ethash --solo --wallet YOUR_ETH_ADDRESS --gpu
```

#### Pool Mining
```bash
# Connect to mining pool
./otedama --pool stratum+tcp://127.0.0.1:3333 --wallet YOUR_ADDRESS --worker WORKER_NAME
```

#### P2P Pool Mode
```bash
# Start as P2P pool node
./otedama --p2p --listen 0.0.0.0:8333 --bootstrap 127.0.0.1:8333,127.0.0.1:8334
```

## Configuration

### Configuration File
Create `config.yaml`:

```yaml
# Mining configuration
mining:
  algorithm: sha256d
  threads: 0  # 0 = auto-detect
  intensity: 20
  
# Pool configuration  
pool:
  url: stratum+tcp://127.0.0.1:3333
  wallet: YOUR_WALLET_ADDRESS
  worker: worker1
  password: x
  
# P2P configuration
p2p:
  enabled: true
  listen: 0.0.0.0:8333
  max_peers: 50
  bootstrap_nodes:
    - 127.0.0.1:8333
    - 127.0.0.1:8334
    
# Hardware configuration
hardware:
  cpu:
    enabled: true
    threads: 0  # 0 = auto
  gpu:
    enabled: true
    devices: [0, 1]  # GPU indices
    intensity: 22
  asic:
    enabled: true
    scan_interval: 30s
    
# Monitoring
monitoring:
  enabled: true
  listen: 0.0.0.0:9090
  metrics_interval: 10s
```

### Environment Variables
```bash
OTEDAMA_CONFIG_PATH=/path/to/config.yaml
OTEDAMA_LOG_LEVEL=info
OTEDAMA_DATA_DIR=/var/lib/otedama
OTEDAMA_WALLET_ADDRESS=YOUR_ADDRESS
```

## API Reference

### REST API
The monitoring server provides a REST API on port 9090:

```bash
# Get mining statistics
curl http://localhost:9090/api/stats

# Get peer information
curl http://localhost:9090/api/peers

# Get hardware status
curl http://localhost:9090/api/hardware

# Control mining
curl -X POST http://localhost:9090/api/mining/start
curl -X POST http://localhost:9090/api/mining/stop
```

### WebSocket API
Real-time updates via WebSocket:

```javascript
const ws = new WebSocket('ws://localhost:9090/ws');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Hash rate:', data.hashrate);
  console.log('Shares:', data.shares);
};
```

## Hardware Support

### CPU Mining
- **x86-64**: AVX2, AVX512, SSE4, SHA extensions
- **ARM64**: NEON, SHA extensions
- **Algorithms**: All supported (optimized for RandomX)

### GPU Mining
- **NVIDIA**: CUDA 11.0+ (RTX 30xx, 40xx series optimized)
- **AMD**: ROCm 5.0+ or OpenCL 2.0
- **Intel**: Level Zero or OpenCL
- **Algorithms**: Ethash, KawPow, Autolykos2, ProgPow

### ASIC Support
- **Bitmain**: Antminer S9, S17, S19 series
- **Whatsminer**: M20, M30, M50 series
- **Canaan**: AvalonMiner series
- **Innosilicon**: T2, T3 series

## Performance Tuning

### CPU Optimization
```bash
# Maximum performance
./otedama --cpu-threads $(nproc) --cpu-affinity --huge-pages

# Power efficient
./otedama --cpu-threads $(nproc)/2 --cpu-freq-governor powersave
```

### GPU Optimization
```bash
# NVIDIA optimization
./otedama --gpu-devices 0,1 --gpu-intensity 24 --gpu-mem-clock +1000 --gpu-core-clock +150

# AMD optimization
./otedama --gpu-devices 0,1 --gpu-intensity 22 --gpu-worksize 256
```

### Memory Settings
```bash
# Enable huge pages (Linux)
sudo sysctl -w vm.nr_hugepages=1280
./otedama --huge-pages

# Increase memory limits
ulimit -l unlimited
```

## Monitoring and Diagnostics

### Built-in Dashboard
Access the web dashboard at `http://localhost:9090`

### Prometheus Metrics
Metrics available at `http://localhost:9090/metrics`

```yaml
# Example Prometheus configuration
scrape_configs:
  - job_name: 'otedama'
    static_configs:
      - targets: ['localhost:9090']
```

### Logging
```bash
# Set log level
./otedama --log-level debug

# Log to file
./otedama --log-file /var/log/otedama.log

# JSON logging
./otedama --log-format json
```

## Security

### Authentication
- JWT-based API authentication
- TLS/SSL support for all connections
- Hardware wallet integration

### Best Practices
1. Always use TLS for remote connections
2. Enable firewall rules for mining ports
3. Use strong passwords for pool authentication
4. Regular security updates
5. Monitor for unusual activity

## Troubleshooting

### Common Issues

#### Low Hash Rate
1. Check CPU/GPU drivers are up to date
2. Verify thermal throttling: `./otedama --hardware-monitor`
3. Adjust intensity settings
4. Check power limits

#### Connection Issues
1. Verify firewall settings
2. Check pool URL and credentials
3. Test network connectivity: `./otedama --test-pool POOL_URL`

#### Hardware Not Detected
1. Update drivers
2. Check device permissions
3. Run hardware scan: `./otedama --scan-hardware`

### Debug Mode
```bash
# Enable debug logging
./otedama --debug --verbose

# Hardware diagnostics
./otedama --diagnose

# Network diagnostics
./otedama --test-network
```

## Development

### Building from Source
```bash
# Requirements
go 1.21+
gcc/clang (for CGO)
CUDA toolkit (for NVIDIA GPU)
ROCm (for AMD GPU)

# Build with all features
make build-all

# Build specific target
make build-cpu
make build-gpu
make build-asic
```

### Testing
```bash
# Run all tests
make test

# Run benchmarks
make bench

# Run integration tests
make test-integration
```

### Contributing
1. Fork the repository
2. Create feature branch
3. Commit changes
4. Push to branch
5. Create pull request

## License

MIT License - See LICENSE file for details

## Support

### Documentation
- [Documentation Index](en/INDEX.md)
- [Development Guide](en/DEVELOPMENT.md)
- [Production Deployment](en/PRODUCTION_DEPLOYMENT.md)
- [Security Guide](en/SECURITY.md)
- [Architecture](en/ARCHITECTURE.md)
- [Features](en/FEATURES.md)
- [Roadmap](en/ROADMAP.md)
- [National Operations Manual](en/NATIONAL_OPERATIONS_MANUAL.md)

### Community
- GitHub Issues: Report bugs and request features

 

## Disclaimer

Mining cryptocurrency requires significant computational resources and electricity. Ensure you understand the costs and legal requirements in your jurisdiction before mining. The software is provided as-is without warranty.