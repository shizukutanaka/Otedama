# Otedama Setup Guide

## Table of Contents

1. [System Requirements](#system-requirements)
2. [Installation](#installation)
3. [Configuration](#configuration)
4. [Running Otedama](#running-otedama)
5. [Mining Configuration](#mining-configuration)
6. [Troubleshooting](#troubleshooting)

## System Requirements

### Minimum Requirements

- **Operating System**: Ubuntu 20.04+, Windows 10+, or macOS 11+
- **CPU**: x64 processor (2+ cores)
- **RAM**: 4GB
- **Storage**: 20GB SSD
- **Network**: Stable broadband connection
- **Node.js**: v18.0.0 or higher

### Recommended Requirements

- **CPU**: 8+ cores for CPU mining
- **GPU**: NVIDIA RTX 3060+ or AMD RX 6600+ for GPU mining
- **RAM**: 16GB or more
- **Storage**: 100GB NVMe SSD
- **Network**: Gigabit connection with low latency

## Installation

### 1. Prerequisites

Install Node.js and npm:

**Ubuntu/Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Windows:**
Download and install from [nodejs.org](https://nodejs.org/)

**macOS:**
```bash
brew install node
```

### 2. Clone Repository

```bash
git clone [repository-url]
cd Otedama
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Build Native Modules (Optional)

For optimized performance:

```bash
npm run build:native
```

## Configuration

### 1. Create Configuration File

Copy the example configuration:

```bash
cp otedama.config.example.js otedama.config.js
```

### 2. Edit Configuration

Open `otedama.config.js` and configure:

```javascript
module.exports = {
  // Mining configuration
  mining: {
    // Your mining wallet address
    walletAddress: 'YOUR_WALLET_ADDRESS',
    
    // Worker name (optional)
    workerName: 'worker1',
    
    // Mining algorithm
    algorithm: 'auto', // or specific: 'sha256', 'scrypt', etc.
    
    // Pool or solo mining
    mode: 'pool', // or 'solo'
  },
  
  // Hardware configuration
  hardware: {
    // CPU mining settings
    cpu: {
      enabled: true,
      threads: 'auto', // or specific number
      intensity: 80    // 0-100
    },
    
    // GPU mining settings
    gpu: {
      enabled: true,
      devices: 'auto', // or [0, 1] for specific GPUs
      intensity: 95    // 0-100
    }
  },
  
  // Network configuration
  network: {
    // Pool server (if using pool mode)
    pool: {
      host: 'pool.example.com',
      port: 3333
    },
    
    // P2P settings
    p2p: {
      enabled: true,
      port: 33333,
      maxPeers: 50
    }
  },
  
  // Monitoring
  monitoring: {
    enabled: true,
    port: 8080
  }
};
```

### 3. Advanced Configuration

For advanced users, additional options are available:

```javascript
// Performance tuning
performance: {
  // Memory allocation
  memoryLimit: 8192, // MB
  
  // Cache settings
  cacheSize: 1024,   // MB
  
  // Network optimization
  connectionPoolSize: 100
},

// Security settings
security: {
  // Enable ZKP authentication
  zkpAuth: true,
  
  // SSL/TLS
  ssl: {
    enabled: true,
    cert: './certs/cert.pem',
    key: './certs/key.pem'
  }
}
```

## Running Otedama

### 1. Setup Wizard (Recommended for First Time)

```bash
npm run setup
```

This will:
- Detect your hardware
- Run benchmarks
- Configure optimal settings
- Generate necessary files

### 2. Start Mining

**Basic start:**
```bash
npm start
```

**With specific configuration:**
```bash
npm start -- --config ./my-config.js
```

**Production mode:**
```bash
npm run start:production
```

### 3. Using Docker

Build image:
```bash
docker build -t otedama .
```

Run container:
```bash
docker run -d \
  --name otedama-miner \
  --gpus all \
  -p 8080:8080 \
  -v $(pwd)/config:/app/config \
  otedama
```

### 4. Systemd Service (Linux)

Install as service:
```bash
sudo npm run install:service
```

Control service:
```bash
sudo systemctl start otedama
sudo systemctl stop otedama
sudo systemctl status otedama
```

## Mining Configuration

### Pool Mining

1. Choose a compatible pool
2. Configure pool settings:

```javascript
mining: {
  mode: 'pool',
  pool: {
    url: 'stratum+tcp://pool.example.com:3333',
    user: 'YOUR_WALLET_ADDRESS.WORKER_NAME',
    pass: 'x'
  }
}
```

### Solo Mining

1. Ensure you have a full node running
2. Configure solo settings:

```javascript
mining: {
  mode: 'solo',
  daemon: {
    host: 'localhost',
    port: 8332,
    user: 'rpcuser',
    pass: 'rpcpassword'
  }
}
```

### Multi-Algorithm Mining

Enable profit switching:

```javascript
mining: {
  algorithm: 'profit-switch',
  profitSwitch: {
    interval: 300, // Check every 5 minutes
    threshold: 5   // Switch if 5% more profitable
  }
}
```

### Hardware Optimization

**CPU Mining:**
```javascript
cpu: {
  algorithm: 'randomx',
  threads: 8,
  affinity: true,
  hugepages: true
}
```

**GPU Mining:**
```javascript
gpu: {
  algorithm: 'ethash',
  devices: [0, 1],
  intensity: 95,
  memoryTweak: 2
}
```

## Troubleshooting

### Common Issues

**Hardware not detected:**
```bash
npm run detect:hardware
```

**Low hashrate:**
```bash
npm run benchmark
npm run optimize
```

**Connection issues:**
```bash
npm run diagnose:network
```

**High CPU usage:**
- Reduce CPU threads in configuration
- Lower intensity setting
- Check for thermal throttling

### Debug Mode

Enable detailed logging:

```bash
DEBUG=otedama:* npm start
```

### Performance Monitoring

Access dashboard at: http://localhost:8080

Monitor:
- Real-time hashrate
- Temperature and power usage
- Share acceptance rate
- Network latency

### Getting Help

1. Check logs:
```bash
tail -f logs/otedama.log
```

2. Run diagnostics:
```bash
npm run diagnose
```

3. Community support:
- GitHub Issues
- Community Forums
- Documentation

## Security Considerations

1. **Never share your private keys or seed phrases**
2. **Use strong passwords for web interface**
3. **Keep software updated**
4. **Monitor for unusual activity**
5. **Use firewall rules to limit access**

## Next Steps

- [API Documentation](./API.md)
- [Advanced Configuration](./ADVANCED.md)
- [Optimization Guide](./OPTIMIZATION.md)
- [Security Best Practices](./SECURITY.md)