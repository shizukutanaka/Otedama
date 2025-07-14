# Deployment Guide

This guide covers deploying Otedama in various environments.

## Table of Contents

1. [Requirements](#requirements)
2. [Quick Start](#quick-start)
3. [Linux Deployment](#linux-deployment)
4. [Windows Deployment](#windows-deployment)
5. [Docker Deployment](#docker-deployment)
6. [Cloud Deployment](#cloud-deployment)
7. [Security Hardening](#security-hardening)
8. [Performance Tuning](#performance-tuning)
9. [Monitoring Setup](#monitoring-setup)
10. [Troubleshooting](#troubleshooting)

## Requirements

### Minimum Requirements
- **OS**: Linux (Ubuntu 20.04+), Windows 10+, macOS 10.15+
- **Node.js**: 18.0.0 or higher
- **RAM**: 1GB minimum, 2GB recommended
- **Storage**: 1GB for application + database growth
- **Network**: Stable internet connection
- **Ports**: 8080 (API), 3333 (Stratum), 8333 (P2P)

### Recommended Specifications
- **CPU**: 4+ cores for mining operations
- **RAM**: 4GB+ for high miner count
- **Storage**: SSD for database performance
- **Network**: Low latency, high bandwidth

## Quick Start

### 1. Download and Extract
```bash
git clone https://github.com/otedama/otedama.git
cd otedama
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure
```bash
node index.js --wallet YOUR_WALLET_ADDRESS --currency RVN
```

### 4. Start
```bash
npm start
```

## Linux Deployment

### Automated Installation

```bash
cd deploy
chmod +x install.sh
./install.sh
```

This script will:
- Install Node.js if needed
- Create system user
- Set up systemd service
- Configure firewall
- Set up automated backups
- Configure monitoring

### Manual Installation

1. **Install Node.js**
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

2. **Create User**
```bash
sudo useradd -r -s /bin/bash -m -d /opt/otedama otedama
```

3. **Install Otedama**
```bash
sudo mkdir -p /opt/otedama
sudo cp -r * /opt/otedama/
sudo chown -R otedama:otedama /opt/otedama
cd /opt/otedama
sudo -u otedama npm install
```

4. **Configure**
```bash
sudo -u otedama node index.js --wallet YOUR_WALLET --currency RVN
```

5. **Install Service**
```bash
sudo cp deploy/otedama.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable otedama
sudo systemctl start otedama
```

### Service Management

```bash
# Check status
sudo systemctl status otedama

# View logs
sudo journalctl -u otedama -f

# Restart
sudo systemctl restart otedama

# Stop
sudo systemctl stop otedama
```

## Windows Deployment

### Automated Installation

1. Run as Administrator:
```batch
cd deploy
install-windows.bat
```

### Manual Installation

1. **Create Directory**
```batch
mkdir C:\Otedama
cd C:\Otedama
```

2. **Copy Files**
```batch
xcopy /E /Y path\to\otedama\* C:\Otedama\
```

3. **Install Dependencies**
```batch
npm install
```

4. **Configure**
```batch
node index.js --wallet YOUR_WALLET --currency RVN
```

5. **Install as Service**
```batch
npm install -g node-windows
node deploy\install-service.js
```

### Service Management

```batch
# Windows Services Manager
services.msc

# Command line
sc query "Otedama Mining Pool"
sc stop "Otedama Mining Pool"
sc start "Otedama Mining Pool"
```

## Docker Deployment

### Build Image

Create `Dockerfile`:
```dockerfile
FROM node:18-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN mkdir -p data logs backups

EXPOSE 8080 3333 8333

CMD ["node", "index.js"]
```

Build:
```bash
docker build -t otedama .
```

### Run Container

```bash
docker run -d \
  --name otedama \
  -p 8080:8080 \
  -p 3333:3333 \
  -p 8333:8333 \
  -v otedama-data:/app/data \
  -v otedama-logs:/app/logs \
  -e NODE_ENV=production \
  otedama
```

### Docker Compose

Create `docker-compose.yml`:
```yaml
version: '3.8'

services:
  otedama:
    build: .
    container_name: otedama
    restart: always
    ports:
      - "8080:8080"
      - "3333:3333"
      - "8333:8333"
    volumes:
      - otedama-data:/app/data
      - otedama-logs:/app/logs
      - otedama-backups:/app/backups
    environment:
      - NODE_ENV=production
      - NODE_OPTIONS=--max-old-space-size=1024
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  otedama-data:
  otedama-logs:
  otedama-backups:
```

Run:
```bash
docker-compose up -d
```

## Cloud Deployment

### AWS EC2

1. **Launch Instance**
   - Ubuntu 20.04 LTS
   - t3.medium or larger
   - 20GB SSD

2. **Security Group**
   - Port 22 (SSH)
   - Port 8080 (API)
   - Port 3333 (Stratum)
   - Port 8333 (P2P)

3. **Deploy**
```bash
ssh ubuntu@your-instance
git clone https://github.com/otedama/otedama.git
cd otedama/deploy
./install.sh
```

### DigitalOcean

1. **Create Droplet**
   - Ubuntu 20.04
   - 2GB RAM minimum
   - Enable backups

2. **Deploy**
```bash
ssh root@your-droplet
cd /opt
git clone https://github.com/otedama/otedama.git
cd otedama/deploy
./install.sh
```

### Google Cloud Platform

1. **Create VM Instance**
   - e2-medium or larger
   - Ubuntu 20.04
   - Allow HTTP/HTTPS traffic

2. **Firewall Rules**
```bash
gcloud compute firewall-rules create otedama-api --allow tcp:8080
gcloud compute firewall-rules create otedama-stratum --allow tcp:3333
gcloud compute firewall-rules create otedama-p2p --allow tcp:8333
```

## Security Hardening

### 1. Enable Authentication

Edit `otedama.json`:
```json
{
  "security": {
    "enableAuth": true,
    "enableRateLimit": true,
    "maxRequestsPerMinute": 60
  }
}
```

Generate API key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2. SSL/TLS Setup

Using Nginx reverse proxy:

```nginx
server {
    listen 443 ssl;
    server_name pool.example.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 3. Firewall Configuration

```bash
# UFW (Ubuntu)
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3333/tcp
sudo ufw allow 8333/tcp
sudo ufw enable
```

### 4. User Permissions

```bash
# Restrict file permissions
sudo chmod 600 /opt/otedama/otedama.json
sudo chmod 700 /opt/otedama/data
sudo chmod 700 /opt/otedama/backups
```

## Performance Tuning

### 1. System Limits

Edit `/etc/security/limits.conf`:
```
otedama soft nofile 65536
otedama hard nofile 65536
otedama soft nproc 32768
otedama hard nproc 32768
```

### 2. Kernel Parameters

Edit `/etc/sysctl.conf`:
```
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
```

Apply:
```bash
sudo sysctl -p
```

### 3. Node.js Optimization

Set environment variables:
```bash
export NODE_ENV=production
export NODE_OPTIONS="--max-old-space-size=2048"
export UV_THREADPOOL_SIZE=16
```

### 4. Database Optimization

Regular maintenance:
```bash
# Vacuum database
sqlite3 /opt/otedama/data/otedama.db "VACUUM;"

# Analyze tables
sqlite3 /opt/otedama/data/otedama.db "ANALYZE;"
```

## Monitoring Setup

### 1. System Monitoring

```bash
# Start monitor with webhook
node monitor.js --webhook https://discord.com/api/webhooks/YOUR_WEBHOOK

# Or add to crontab
*/5 * * * * cd /opt/otedama && node monitor.js >> logs/monitor.log 2>&1
```

### 2. Prometheus Integration

Configure Prometheus to scrape metrics:
```yaml
scrape_configs:
  - job_name: 'otedama'
    static_configs:
      - targets: ['localhost:9090']
```

### 3. Grafana Dashboard

Import the Otedama dashboard:
1. Add Prometheus data source
2. Import dashboard from `monitoring/grafana/dashboard.json`

### 4. Alerts Configuration

Edit `monitor.js` thresholds:
```javascript
this.thresholds = {
  hashrateDrop: 20,    // % drop
  minerDrop: 30,       // % drop
  shareRate: 80,       // % minimum
  responseTime: 1000,  // ms
  memoryUsage: 85,     // %
  cpuUsage: 90         // %
};
```

## Troubleshooting

### Common Issues

#### 1. Port Already in Use
```bash
# Find process using port
sudo lsof -i :8080
sudo lsof -i :3333

# Kill process
sudo kill -9 <PID>
```

#### 2. Database Locked
```bash
# Stop service
sudo systemctl stop otedama

# Remove lock files
rm /opt/otedama/data/otedama.db-shm
rm /opt/otedama/data/otedama.db-wal

# Start service
sudo systemctl start otedama
```

#### 3. High Memory Usage
```bash
# Increase Node.js memory limit
export NODE_OPTIONS="--max-old-space-size=4096"

# Or edit systemd service
sudo systemctl edit otedama
# Add: Environment="NODE_OPTIONS=--max-old-space-size=4096"
```

#### 4. Miners Can't Connect
- Check firewall rules
- Verify Stratum port is open
- Check wallet address format
- Review Stratum logs

### Debug Mode

Run with debug output:
```bash
DEBUG=true node index.js
```

### Health Check

```bash
curl http://localhost:8080/health
```

### Backup Recovery

```bash
# List backups
node backup.js list

# Restore from backup
node backup.js restore backup_2024-01-15T10-30-00_manual
```

## Support

- GitHub Issues: https://github.com/otedama/otedama/issues
- Documentation: https://github.com/otedama/otedama/wiki
- Discord: https://discord.gg/otedama

---

For additional deployment scenarios or advanced configurations, please refer to the documentation or contact support.
