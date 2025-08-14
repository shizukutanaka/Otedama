# Production Deployment Guide

## Overview

This guide provides comprehensive instructions for deploying Otedama mining software in production environments, including enterprise-grade configurations, monitoring, and operational procedures.

## Prerequisites

### System Requirements
- **Operating System**: Linux (Ubuntu 20.04+ recommended), Windows Server 2019+, macOS 12+
- **Memory**: 8GB RAM minimum, 16GB+ recommended for large deployments
- **CPU**: 4+ cores, 8+ cores recommended for multi-device mining
- **Storage**: 50GB+ available space for logs and data
- **Network**: Stable internet connection, 100Mbps+ recommended

### Dependencies
- **Go**: 1.19+ (latest stable recommended)
- **SQLite**: 3.35+ (bundled with application)
- **Prometheus**: 2.30+ (for monitoring)
- **Grafana**: 8.0+ (for visualization)

## Installation

### 1. Environment Setup

```bash
# Create dedicated user
sudo useradd -m -s /bin/bash otedama
sudo su - otedama

# Create directory structure
mkdir -p /opt/otedama/{bin,config,data,logs}
cd /opt/otedama

# Download latest release
wget https://github.com/shizukutanaka/Otedama/releases/latest/download/otedama-linux-amd64.tar.gz
tar -xzf otedama-linux-amd64.tar.gz
chmod +x bin/otedama
```

### 2. Configuration

#### Production Configuration File

Create `/opt/otedama/config/production.yaml`:

```yaml
# Production Configuration
server:
  host: "0.0.0.0"
  port: 8080
  read_timeout: 30s
  write_timeout: 30s
  idle_timeout: 120s

mining:
  algorithm: "sha256d"
  cpu_threads: 4
  intensity: 15
  max_memory_mb: 4096
  auto_optimize: true
  
  devices:
    cpu:
      enabled: true
      threads: 4
    gpu:
      enabled: true
      devices: [0, 1, 2]
    asic:
      enabled: true
      devices: ["asic0", "asic1"]

database:
  path: "/opt/otedama/data/otedama.db"
  max_connections: 100
  connection_timeout: 30s
  wal_mode: true
  
monitoring:
  enabled: true
  metrics_port: 8081
  health_check_interval: 30s
  
logging:
  level: "info"
  file: "/opt/otedama/logs/otedama.log"
  max_size: 100MB
  max_backups: 10
  max_age: 30

security:
  rate_limiting:
    enabled: true
    requests_per_minute: 100
    burst_size: 200
  
  cors:
    enabled: true
    allowed_origins: ["https://yourdomain.com"]
    allowed_methods: ["GET", "POST", "PUT", "DELETE"]
    allowed_headers: ["Content-Type", "Authorization"]
```

### 3. Systemd Service

Create `/etc/systemd/system/otedama.service`:

```ini
[Unit]
Description=Otedama Mining Pool
After=network.target
Wants=network.target

[Service]
Type=simple
User=otedama
Group=otedama
WorkingDirectory=/opt/otedama
ExecStart=/opt/otedama/bin/otedama --config /opt/otedama/config/production.yaml
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

# Security settings
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/otedama/data /opt/otedama/logs
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true

# Resource limits
LimitNOFILE=65536
LimitNPROC=32768
LimitMEMLOCK=infinity

[Install]
WantedBy=multi-user.target
```

### 4. Enable and Start Service

```bash
sudo systemctl daemon-reload
sudo systemctl enable otedama
sudo systemctl start otedama
sudo systemctl status otedama
```

## Monitoring Setup

### 1. Prometheus Configuration

Create `/opt/otedama/config/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'otedama'
    static_configs:
      - targets: ['localhost:8081']
    metrics_path: /metrics
    scrape_interval: 30s

  - job_name: 'node-exporter'
    static_configs:
      - targets: ['localhost:9100']
```

### 2. Grafana Dashboard

Import the provided Grafana dashboard JSON:

```json
{
  "dashboard": {
    "id": null,
    "title": "Otedama Mining Pool",
    "tags": ["mining", "otedama"],
    "timezone": "browser",
    "panels": [
      {
        "title": "Hash Rate",
        "type": "graph",
        "targets": [
          {
            "expr": "mining_hash_rate",
            "legendFormat": "Hash Rate"
          }
        ]
      },
      {
        "title": "Device Status",
        "type": "stat",
        "targets": [
          {
            "expr": "mining_device_count",
            "legendFormat": "Active Devices"
          }
        ]
      },
      {
        "title": "Jobs Processed",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(mining_jobs_processed_total[5m])",
            "legendFormat": "Jobs/sec"
          }
        ]
      }
    ]
  }
}
```

## Security Configuration

### 1. Firewall Setup

```bash
# Allow specific ports
sudo ufw allow 8080/tcp
sudo ufw allow 8081/tcp
sudo ufw allow 22/tcp
sudo ufw enable

# Rate limiting with fail2ban
sudo apt install fail2ban
sudo systemctl enable fail2ban
```

### 2. SSL/TLS Configuration

```bash
# Using Let's Encrypt
sudo apt install certbot
sudo certbot certonly --standalone -d yourdomain.com

# Update configuration to use SSL
# Modify production.yaml to include SSL settings
```

## Backup and Recovery

### 1. Automated Backup Script

Create `/opt/otedama/scripts/backup.sh`:

```bash
#!/bin/bash
BACKUP_DIR="/opt/otedama/backups"
DATE=$(date +%Y%m%d_%H%M%S)

# Create backup directory
mkdir -p $BACKUP_DIR

# Backup database
cp /opt/otedama/data/otedama.db $BACKUP_DIR/otedama_$DATE.db

# Backup configuration
cp /opt/otedama/config/production.yaml $BACKUP_DIR/config_$DATE.yaml

# Compress backups
tar -czf $BACKUP_DIR/otedama_backup_$DATE.tar.gz $BACKUP_DIR/*_$DATE*

# Clean old backups (keep last 7 days)
find $BACKUP_DIR -name "*.tar.gz" -mtime +7 -delete

# Log backup completion
echo "Backup completed: $DATE" >> /opt/otedama/logs/backup.log
```

### 2. Backup Cron Job

```bash
# Add to crontab
sudo crontab -e

# Add this line for daily backups at 2 AM
0 2 * * * /opt/otedama/scripts/backup.sh
```

## Performance Tuning

### 1. System Optimization

```bash
# Increase file descriptor limits
echo "* soft nofile 65536" >> /etc/security/limits.conf
echo "* hard nofile 65536" >> /etc/security/limits.conf

# Optimize kernel parameters
echo "net.core.somaxconn = 65536" >> /etc/sysctl.conf
echo "net.ipv4.tcp_max_syn_backlog = 65536" >> /etc/sysctl.conf
sysctl -p
```

### 2. Application Tuning

```yaml
# Advanced configuration options
performance:
  gc_percent: 100
  max_memory_mb: 8192
  cpu_profile: false
  memory_profile: false
  
optimization:
  cache_size: 1000
  batch_size: 100
  worker_threads: 8
  
debugging:
  debug_mode: false
  verbose_logging: false
  metrics_detailed: false
```

## Health Checks

### 1. Health Check Script

Create `/opt/otedama/scripts/health-check.sh`:

```bash
#!/bin/bash
HEALTH_URL="http://localhost:8081/health"

# Check if service is running
if ! systemctl is-active --quiet otedama; then
    echo "ERROR: Otedama service is not running"
    exit 1
fi

# Check health endpoint
if ! curl -f $HEALTH_URL > /dev/null 2>&1; then
    echo "ERROR: Health check failed"
    exit 1
fi

echo "OK: All health checks passed"
```

### 2. Monitoring Integration

```bash
# Add to monitoring tools
sudo chmod +x /opt/otedama/scripts/health-check.sh

# Test health check
/opt/otedama/scripts/health-check.sh
```

## Troubleshooting

### Common Issues

1. **Port conflicts**: Check with `netstat -tlnp | grep 8080`
2. **Permission denied**: Ensure correct file ownership and permissions
3. **Memory issues**: Monitor with `htop` or `free -h`
4. **Database locks**: Check SQLite write-ahead logging

### Log Analysis

```bash
# Real-time log monitoring
tail -f /opt/otedama/logs/otedama.log

# Error log analysis
grep ERROR /opt/otedama/logs/otedama.log | tail -20

# Performance log analysis
grep "performance" /opt/otedama/logs/otedama.log | tail -20
```

## Scaling

### Horizontal Scaling

```yaml
# Docker Compose for scaling
version: '3.8'
services:
  otedama-1:
    image: otedama:latest
    ports:
      - "8080:8080"
    environment:
      - NODE_ID=1
  
  otedama-2:
    image: otedama:latest
    ports:
      - "8082:8080"
    environment:
      - NODE_ID=2
```

### Load Balancing

```nginx
# Nginx load balancer configuration
upstream otedama {
    server localhost:8080;
    server localhost:8082;
    server localhost:8083;
}

server {
    listen 80;
    server_name yourdomain.com;
    
    location / {
        proxy_pass http://otedama;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Maintenance

### Regular Maintenance Tasks

1. **Daily**: Check logs and metrics
2. **Weekly**: Review backup integrity
3. **Monthly**: Update dependencies and security patches
4. **Quarterly**: Performance review and optimization

### Update Procedures

```bash
# Safe update procedure
sudo systemctl stop otedama
sudo systemctl status otedama

# Backup current version
sudo cp /opt/otedama/bin/otedama /opt/otedama/bin/otedama.backup

# Update application
sudo systemctl start otedama
sudo systemctl status otedama
```

## Support

For production support:
- Check `/opt/otedama/logs/` for detailed logs
- Review monitoring dashboards
- Consult troubleshooting guide
- Contact support with detailed system information
