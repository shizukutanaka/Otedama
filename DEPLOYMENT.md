# Otedama Deployment Guide

## Table of Contents
1. [Requirements](#requirements)
2. [Quick Start](#quick-start)
3. [Docker Deployment](#docker-deployment)
4. [Kubernetes Deployment](#kubernetes-deployment)
5. [Manual Deployment](#manual-deployment)
6. [Configuration](#configuration)
7. [Security](#security)
8. [Monitoring](#monitoring)
9. [Maintenance](#maintenance)
10. [Troubleshooting](#troubleshooting)

## Requirements

### Minimum Hardware
- CPU: 4 cores (Intel/AMD x64)
- RAM: 8GB
- Storage: 100GB SSD
- Network: 100Mbps

### Recommended Hardware
- CPU: 8+ cores
- RAM: 16GB+
- Storage: 500GB+ NVMe SSD
- Network: 1Gbps+

### Software Requirements
- Node.js 18+
- Bitcoin Core or compatible node
- Linux (Ubuntu 20.04+ recommended)
- Docker (optional)
- Kubernetes (optional)

## Quick Start

### 1. Clone Repository
```bash
git clone https://github.com/yourusername/otedama.git
cd otedama
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment
```bash
cp .env.example .env
cp otedama.config.example.js otedama.config.js

# Edit configuration
nano .env
```

### 4. Start Pool
```bash
# Simple start
npm run start:pool

# Production cluster mode
npm run start:pool -- --mode cluster --workers 4
```

## Docker Deployment

### 1. Build Image
```bash
docker build -t otedama:latest .
```

### 2. Run with Docker Compose
```bash
# Development
docker-compose up -d

# Production
docker-compose -f docker-compose.production.yml up -d
```

### 3. Check Status
```bash
docker-compose ps
docker-compose logs -f otedama
```

### Docker Compose Configuration
```yaml
version: '3.8'
services:
  otedama:
    image: otedama:latest
    ports:
      - "3333:3333"  # Stratum
      - "8080:8080"  # API
    volumes:
      - ./data:/app/data
      - ./logs:/app/logs
    environment:
      - NODE_ENV=production
    restart: unless-stopped
```

## Kubernetes Deployment

### 1. Create Namespace
```bash
kubectl create namespace otedama
```

### 2. Apply ConfigMap
```bash
kubectl apply -f kubernetes/configmap.yaml
```

### 3. Deploy Application
```bash
kubectl apply -f kubernetes/deployment.yaml
kubectl apply -f kubernetes/service.yaml
```

### 4. Check Status
```bash
kubectl get pods -n otedama
kubectl logs -f deployment/otedama -n otedama
```

### Example Deployment
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otedama
  namespace: otedama
spec:
  replicas: 3
  selector:
    matchLabels:
      app: otedama
  template:
    metadata:
      labels:
        app: otedama
    spec:
      containers:
      - name: otedama
        image: otedama:latest
        ports:
        - containerPort: 3333
        - containerPort: 8080
        resources:
          requests:
            memory: "2Gi"
            cpu: "1000m"
          limits:
            memory: "8Gi"
            cpu: "4000m"
```

## Manual Deployment

### 1. System Setup
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install dependencies
sudo apt install -y build-essential git curl

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Create User
```bash
sudo useradd -m -s /bin/bash otedama
sudo usermod -aG sudo otedama
```

### 3. Setup Application
```bash
sudo -u otedama -i
git clone https://github.com/yourusername/otedama.git
cd otedama
npm install --production
```

### 4. Systemd Service
```bash
# Create service file
sudo nano /etc/systemd/system/otedama.service
```

```ini
[Unit]
Description=Otedama Mining Pool
After=network.target

[Service]
Type=simple
User=otedama
WorkingDirectory=/home/otedama/otedama
ExecStart=/usr/bin/node start-mining-pool.js --mode cluster
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start
sudo systemctl enable otedama
sudo systemctl start otedama
```

## Configuration

### Environment Variables (.env)
```env
# Pool Configuration
POOL_NAME=My Otedama Pool
POOL_ADDRESS=bc1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
POOL_FEE=0.01

# Network
STRATUM_PORT=3333
API_PORT=8080
P2P_PORT=33333

# Bitcoin Node
BITCOIN_RPC_URL=http://127.0.0.1:8332
BITCOIN_RPC_USER=bitcoinrpc
BITCOIN_RPC_PASSWORD=secure_password_here

# Security
JWT_SECRET=generate_random_secret_here
API_KEY=generate_api_key_here

# Database
DATABASE_PATH=./data/otedama.db

# Performance
MAX_CONNECTIONS=10000
SHARE_VALIDATION_WORKERS=8
```

### Pool Configuration (otedama.config.js)
```javascript
export default {
  // Pool settings
  poolName: process.env.POOL_NAME,
  algorithm: 'sha256',
  paymentScheme: 'PPLNS',
  minimumPayment: 0.001,
  
  // Performance
  workers: 0, // 0 = auto
  shareValidationWorkers: 8,
  
  // Security
  security: {
    rateLimiting: true,
    ddosProtection: true,
    maxConnectionsPerIP: 5
  },
  
  // Features
  enableStratumV2: true,
  enableASICDiscovery: true,
  enableAnalytics: true
};
```

## Security

### 1. Firewall Setup
```bash
# Allow SSH
sudo ufw allow 22/tcp

# Allow Stratum
sudo ufw allow 3333/tcp

# Allow API (restrict source)
sudo ufw allow from 10.0.0.0/8 to any port 8080

# Enable firewall
sudo ufw enable
```

### 2. SSL/TLS Configuration
```bash
# Install certbot
sudo apt install certbot

# Get certificate
sudo certbot certonly --standalone -d pool.example.com

# Configure in .env
SSL_ENABLED=true
SSL_CERT=/etc/letsencrypt/live/pool.example.com/fullchain.pem
SSL_KEY=/etc/letsencrypt/live/pool.example.com/privkey.pem
```

### 3. Security Best Practices
- Use strong passwords
- Enable 2FA for admin accounts
- Regular security updates
- Monitor logs for suspicious activity
- Implement IP whitelisting
- Use VPN for admin access

## Monitoring

### 1. Prometheus Setup
```yaml
# prometheus.yml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'otedama'
    static_configs:
      - targets: ['localhost:9090']
```

### 2. Grafana Dashboard
1. Import dashboard from `monitoring/grafana/dashboards/`
2. Configure data source
3. Set up alerts

### 3. Health Checks
```bash
# Check pool health
curl http://localhost:8080/health

# Check metrics
curl http://localhost:9090/metrics
```

### 4. Log Monitoring
```bash
# View logs
tail -f logs/otedama.log

# Search errors
grep ERROR logs/otedama.log

# Log rotation
sudo nano /etc/logrotate.d/otedama
```

## Maintenance

### 1. Backup
```bash
# Manual backup
npm run backup:now

# Automated backup (cron)
0 2 * * * cd /home/otedama/otedama && npm run backup:now
```

### 2. Updates
```bash
# Backup first
npm run backup:now

# Pull updates
git pull

# Update dependencies
npm update

# Restart
sudo systemctl restart otedama
```

### 3. Database Maintenance
```bash
# Optimize database
npm run db:optimize

# Clean old data
npm run maintenance:clean
```

## Troubleshooting

### Common Issues

#### 1. Pool Won't Start
```bash
# Check logs
journalctl -u otedama -f

# Validate configuration
npm run validate

# Check permissions
ls -la data/
```

#### 2. Miners Can't Connect
```bash
# Check firewall
sudo ufw status

# Test stratum port
nc -zv localhost 3333

# Check network binding
netstat -tlnp | grep 3333
```

#### 3. High Memory Usage
```bash
# Check memory
free -h

# Restart with limits
node --max-old-space-size=4096 start-mining-pool.js
```

#### 4. Database Errors
```bash
# Check database
sqlite3 data/otedama.db "PRAGMA integrity_check;"

# Rebuild if needed
npm run db:rebuild
```

### Performance Tuning

#### 1. System Limits
```bash
# /etc/security/limits.conf
otedama soft nofile 65536
otedama hard nofile 65536
```

#### 2. Kernel Parameters
```bash
# /etc/sysctl.conf
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.core.netdev_max_backlog = 65535
```

#### 3. Node.js Optimization
```bash
# Use cluster mode
node start-mining-pool.js --mode cluster --workers 8

# Enable profiling
NODE_ENV=production node --prof start-mining-pool.js
```

## Support

### Resources
- Documentation: `/docs`
- GitHub Issues: Report bugs
- Discord: Community support
- Email: support@otedama.io

### Logs Location
- Application: `logs/otedama.log`
- Error: `logs/error.log`
- Access: `logs/access.log`
- Mining: `logs/mining.log`

---

**Version**: 1.0.0
**Last Updated**: 2024
