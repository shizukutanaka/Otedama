# Otedama Mining Pool - Setup Guide

## System Requirements

### Minimum Requirements
- **OS**: Linux (Ubuntu 20.04+), Windows 10+, macOS 10.15+
- **CPU**: 4 cores, 2.4GHz
- **RAM**: 8GB
- **Storage**: 50GB SSD
- **Network**: 100Mbps

### Recommended Requirements
- **OS**: Ubuntu 22.04 LTS
- **CPU**: 8+ cores, 3.0GHz+
- **RAM**: 32GB+
- **Storage**: 500GB NVMe SSD
- **Network**: 1Gbps+

## Installation

### 1. Prerequisites

#### Node.js Installation
```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS/RHEL
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs

# Windows (using Chocolatey)
choco install nodejs

# macOS (using Homebrew)
brew install node
```

#### Database Setup (PostgreSQL)
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install postgresql postgresql-contrib

# Start PostgreSQL service
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Create database and user
sudo -u postgres psql
CREATE DATABASE otedama_mining;
CREATE USER otedama_user WITH PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE otedama_mining TO otedama_user;
\q
```

### 2. Project Installation

```bash
# Clone repository
git clone https://github.com/your-org/otedama.git
cd otedama

# Install dependencies
npm install

# Create environment file
cp .env.template .env
```

### 3. Configuration

#### Environment Variables (.env)
```bash
# Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_NAME=otedama_mining
DB_USER=otedama_user
DB_PASSWORD=your_secure_password

# Mining Pool Configuration
POOL_HOST=0.0.0.0
POOL_PORT=4444
STRATUM_PORT=3333
POOL_FEE=1.0

# Security Configuration
ENCRYPTION_KEY=your_32_character_encryption_key
JWT_SECRET=your_jwt_secret_key

# Monitoring
ENABLE_MONITORING=true
PROMETHEUS_PORT=9090

# Logging
LOG_LEVEL=info
LOG_DIR=./logs
```

#### Mining Configuration
Edit `config/mining-config.json` to customize:
- Pool settings (ports, connections, timeouts)
- Algorithm configurations
- Security settings
- Performance optimizations
- Monitoring options

### 4. Database Migration

```bash
# Run database migrations
npm run migrate

# Verify database setup
npm run migrate:status
```

### 5. SSL/TLS Setup (Recommended)

#### Generate SSL Certificates
```bash
# Using Let's Encrypt (for production)
sudo apt install certbot
sudo certbot certonly --standalone -d your-pool-domain.com

# Or create self-signed certificates (for testing)
mkdir -p ssl
openssl req -x509 -newkey rsa:4096 -keyout ssl/key.pem -out ssl/cert.pem -days 365 -nodes
```

#### Configure SSL in mining-config.json
```json
{
  "ssl": {
    "enabled": true,
    "cert": "ssl/cert.pem",
    "key": "ssl/key.pem",
    "port": 3334
  }
}
```

## Running the Mining Pool

### 1. Development Mode
```bash
npm run dev
```

### 2. Production Mode
```bash
# Build the application
npm run build

# Start production server
npm start

# Or use PM2 for process management
npm install -g pm2
pm2 start ecosystem.config.js
pm2 startup
pm2 save
```

### 3. Docker Deployment
```bash
# Build Docker image
docker build -t otedama-mining-pool .

# Run with Docker Compose
docker-compose up -d

# Check status
docker-compose ps
```

## Monitoring Setup

### 1. Prometheus & Grafana
```bash
# Using Docker Compose
cd monitoring
docker-compose up -d

# Access Grafana at http://localhost:3000
# Default credentials: admin/admin
```

### 2. Log Monitoring
```bash
# View real-time logs
tail -f logs/mining-pool.log

# Using journalctl (if running as service)
sudo journalctl -u otedama-mining-pool -f
```

## Performance Optimization

### 1. System Optimization

#### Linux Kernel Parameters
```bash
# Edit /etc/sysctl.conf
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
net.core.netdev_max_backlog = 5000
vm.swappiness = 10

# Apply changes
sudo sysctl -p
```

#### File Descriptor Limits
```bash
# Edit /etc/security/limits.conf
* soft nofile 65536
* hard nofile 65536

# For systemd services, edit service file
[Service]
LimitNOFILE=65536
```

### 2. Node.js Optimization
```bash
# Set Node.js memory limit
export NODE_OPTIONS="--max-old-space-size=8192"

# Enable garbage collection logging
export NODE_OPTIONS="--max-old-space-size=8192 --trace-gc"
```

### 3. Database Optimization

#### PostgreSQL Configuration
```bash
# Edit postgresql.conf
shared_buffers = 256MB
effective_cache_size = 1GB
work_mem = 4MB
max_connections = 200
checkpoint_completion_target = 0.9
wal_buffers = 16MB
```

## Security Configuration

### 1. Firewall Setup
```bash
# Ubuntu/Debian (UFW)
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 3333/tcp    # Stratum
sudo ufw allow 4444/tcp    # Pool API
sudo ufw allow 9090/tcp    # Prometheus (internal only)
sudo ufw enable

# CentOS/RHEL (firewalld)
sudo firewall-cmd --permanent --add-port=3333/tcp
sudo firewall-cmd --permanent --add-port=4444/tcp
sudo firewall-cmd --reload
```

### 2. DDoS Protection
```bash
# Install fail2ban
sudo apt install fail2ban

# Configure fail2ban for mining pool
sudo cp config/fail2ban/mining-pool.conf /etc/fail2ban/jail.local
sudo systemctl restart fail2ban
```

### 3. Regular Security Updates
```bash
# Ubuntu/Debian
sudo apt update && sudo apt upgrade

# Update Node.js dependencies
npm audit fix
npm update
```

## Troubleshooting

### Common Issues

#### 1. Port Already in Use
```bash
# Check which process is using the port
sudo lsof -i :3333
sudo netstat -tlnp | grep 3333

# Kill process if needed
sudo kill -9 <PID>
```

#### 2. Database Connection Issues
```bash
# Check PostgreSQL status
sudo systemctl status postgresql

# Test database connection
psql -h localhost -U otedama_user -d otedama_mining -c "SELECT 1;"
```

#### 3. Memory Issues
```bash
# Check memory usage
free -h
htop

# Check Node.js heap usage
node --inspect index.js
# Then open Chrome DevTools
```

#### 4. High CPU Usage
```bash
# Check process CPU usage
top -p $(pgrep -f otedama)

# Profile Node.js application
npm install -g clinic
clinic doctor -- node index.js
```

### Log Analysis
```bash
# Check error logs
grep -i error logs/mining-pool.log

# Check performance metrics
grep -i "performance" logs/mining-pool.log

# Monitor real-time metrics
tail -f logs/mining-pool.log | grep "hashrate\|connection\|error"
```

## Maintenance

### 1. Regular Backups
```bash
# Database backup
pg_dump -h localhost -U otedama_user otedama_mining > backup_$(date +%Y%m%d).sql

# Configuration backup
tar -czf config_backup_$(date +%Y%m%d).tar.gz config/ .env
```

### 2. Log Rotation
```bash
# Configure logrotate
sudo cp config/logrotate/mining-pool /etc/logrotate.d/
sudo logrotate -f /etc/logrotate.d/mining-pool
```

### 3. Performance Monitoring
```bash
# Check system performance
iostat 1 5
vmstat 1 5
sar 1 5

# Check mining pool metrics
curl http://localhost:4444/api/stats
curl http://localhost:9090/metrics
```

## Support

### Documentation
- [API Documentation](./API.md)
- [Mining Configuration](./MINING.md)
- [Security Guide](./SECURITY.md)
- [Performance Tuning](./PERFORMANCE.md)

### Community
- GitHub Issues: https://github.com/your-org/otedama/issues
- Discord: https://discord.gg/otedama
- Forum: https://forum.otedama.io

### Professional Support
- Email: support@otedama.io
- Enterprise Support: enterprise@otedama.io