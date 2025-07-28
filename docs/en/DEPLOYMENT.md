# Otedama Deployment Guide

## Table of Contents

1. [Overview](#overview)
2. [Deployment Options](#deployment-options)
3. [Prerequisites](#prerequisites)
4. [Production Deployment](#production-deployment)
5. [Docker Deployment](#docker-deployment)
6. [Kubernetes Deployment](#kubernetes-deployment)
7. [High Availability Setup](#high-availability-setup)
8. [Monitoring Setup](#monitoring-setup)
9. [Security Hardening](#security-hardening)
10. [Maintenance](#maintenance)

## Overview

This guide covers deploying Otedama in various environments, from single-server setups to national-scale infrastructure. Choose the deployment method that best fits your requirements.

## Deployment Options

| Method | Use Case | Complexity | Scalability |
|--------|----------|------------|-------------|
| **Standalone** | Development, Testing | Low | Limited |
| **Docker** | Small to Medium Operations | Medium | Good |
| **Kubernetes** | Enterprise, National Scale | High | Excellent |
| **Multi-Region** | Global Operations | Very High | Maximum |

## Prerequisites

### System Requirements

**Minimum (Single Server):**
- CPU: 8 cores
- RAM: 16GB
- Storage: 500GB SSD
- Network: 1Gbps
- OS: Ubuntu 20.04+ or CentOS 8+

**Recommended (Production):**
- CPU: 32+ cores
- RAM: 64GB+
- Storage: 2TB NVMe SSD
- Network: 10Gbps
- OS: Ubuntu 22.04 LTS

### Software Requirements

```bash
# Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Build tools
sudo apt-get install -y build-essential git

# Database
sudo apt-get install -y postgresql-14 redis

# Monitoring (optional)
sudo apt-get install -y prometheus grafana

# Load balancer (optional)
sudo apt-get install -y nginx haproxy
```

## Production Deployment

### 1. Server Preparation

```bash
# Create dedicated user
sudo useradd -m -s /bin/bash otedama
sudo usermod -aG sudo otedama

# Set up directories
sudo mkdir -p /opt/otedama
sudo chown otedama:otedama /opt/otedama

# Switch to otedama user
sudo su - otedama
```

### 2. Install Otedama

```bash
# Clone repository
cd /opt/otedama
git clone [repository-url] .

# Install dependencies
npm install --production

# Build native modules
npm run build:native

# Create configuration
cp otedama.config.example.js otedama.config.js
```

### 3. Configure Environment

Edit `otedama.config.js`:

```javascript
module.exports = {
  // Production settings
  env: 'production',
  
  // Network configuration
  network: {
    host: '0.0.0.0',
    port: 3333,
    ssl: {
      enabled: true,
      cert: '/path/to/cert.pem',
      key: '/path/to/key.pem'
    }
  },
  
  // Database configuration
  database: {
    host: 'localhost',
    port: 5432,
    name: 'otedama',
    user: 'otedama',
    password: process.env.DB_PASSWORD
  },
  
  // Redis configuration
  redis: {
    host: 'localhost',
    port: 6379,
    password: process.env.REDIS_PASSWORD
  },
  
  // Performance settings
  performance: {
    workers: 'auto', // Use all CPU cores
    memoryLimit: 8192, // MB
    connectionLimit: 100000
  }
};
```

### 4. Set Up Database

```bash
# Create database
sudo -u postgres createuser otedama
sudo -u postgres createdb otedama -O otedama

# Run migrations
NODE_ENV=production npm run migrate

# Create indexes
NODE_ENV=production npm run db:optimize
```

### 5. Configure Systemd Service

Create `/etc/systemd/system/otedama.service`:

```ini
[Unit]
Description=Otedama Mining Pool
After=network.target postgresql.service redis.service
Wants=postgresql.service redis.service

[Service]
Type=notify
ExecStart=/usr/bin/node /opt/otedama/index.js
ExecReload=/bin/kill -USR2 $MAINPID
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=otedama
User=otedama
Group=otedama
Environment=NODE_ENV=production
Environment=NODE_OPTIONS="--max-old-space-size=8192"

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/otedama/data /opt/otedama/logs

[Install]
WantedBy=multi-user.target
```

### 6. Start Service

```bash
# Enable and start service
sudo systemctl daemon-reload
sudo systemctl enable otedama
sudo systemctl start otedama

# Check status
sudo systemctl status otedama
```

## Docker Deployment

### 1. Build Image

```bash
# Production build
docker build -t otedama:latest -f Dockerfile.production .

# Multi-stage build for smaller image
docker build --target production -t otedama:latest .
```

### 2. Docker Compose Setup

Create `docker-compose.production.yml`:

```yaml
version: '3.8'

services:
  otedama:
    image: otedama:latest
    container_name: otedama-pool
    restart: always
    ports:
      - "3333:3333"
      - "8080:8080"
    environment:
      NODE_ENV: production
      DB_HOST: postgres
      REDIS_HOST: redis
    volumes:
      - ./config:/app/config
      - otedama-data:/app/data
      - otedama-logs:/app/logs
    depends_on:
      - postgres
      - redis
    networks:
      - otedama-net
    deploy:
      resources:
        limits:
          cpus: '8'
          memory: 16G
        reservations:
          cpus: '4'
          memory: 8G

  postgres:
    image: postgres:14-alpine
    container_name: otedama-db
    restart: always
    environment:
      POSTGRES_DB: otedama
      POSTGRES_USER: otedama
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks:
      - otedama-net

  redis:
    image: redis:7-alpine
    container_name: otedama-cache
    restart: always
    command: redis-server --requirepass ${REDIS_PASSWORD}
    volumes:
      - redis-data:/data
    networks:
      - otedama-net

  nginx:
    image: nginx:alpine
    container_name: otedama-proxy
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
    depends_on:
      - otedama
    networks:
      - otedama-net

volumes:
  otedama-data:
  otedama-logs:
  postgres-data:
  redis-data:

networks:
  otedama-net:
    driver: bridge
```

### 3. Run with Docker Compose

```bash
# Create .env file
cat > .env << EOF
DB_PASSWORD=secure_password
REDIS_PASSWORD=secure_password
EOF

# Start services
docker-compose -f docker-compose.production.yml up -d

# View logs
docker-compose -f docker-compose.production.yml logs -f

# Scale workers
docker-compose -f docker-compose.production.yml up -d --scale otedama=3
```

## Kubernetes Deployment

### 1. Create Namespace

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: otedama
```

### 2. ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otedama-config
  namespace: otedama
data:
  otedama.config.js: |
    module.exports = {
      env: 'production',
      // ... configuration
    };
```

### 3. Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otedama-pool
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
          name: stratum
        - containerPort: 8080
          name: api
        resources:
          requests:
            memory: "8Gi"
            cpu: "4"
          limits:
            memory: "16Gi"
            cpu: "8"
        volumeMounts:
        - name: config
          mountPath: /app/config
        - name: data
          mountPath: /app/data
        env:
        - name: NODE_ENV
          value: "production"
        - name: DB_HOST
          value: "postgres-service"
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
      volumes:
      - name: config
        configMap:
          name: otedama-config
      - name: data
        persistentVolumeClaim:
          claimName: otedama-data-pvc
```

### 4. Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: otedama-service
  namespace: otedama
spec:
  selector:
    app: otedama
  ports:
  - name: stratum
    port: 3333
    targetPort: 3333
    protocol: TCP
  - name: api
    port: 8080
    targetPort: 8080
    protocol: TCP
  type: LoadBalancer
```

### 5. Horizontal Pod Autoscaler

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: otedama-hpa
  namespace: otedama
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: otedama-pool
  minReplicas: 3
  maxReplicas: 100
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
```

### 6. Deploy to Kubernetes

```bash
# Apply configurations
kubectl apply -f namespace.yaml
kubectl apply -f configmap.yaml
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml
kubectl apply -f hpa.yaml

# Check deployment
kubectl get all -n otedama

# View logs
kubectl logs -f deployment/otedama-pool -n otedama
```

## High Availability Setup

### 1. Multi-Region Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Region US     │     │   Region EU     │     │   Region Asia   │
│                 │     │                 │     │                 │
│ ┌─────────────┐ │     │ ┌─────────────┐ │     │ ┌─────────────┐ │
│ │ Load        │ │     │ │ Load        │ │     │ │ Load        │ │
│ │ Balancer    │ │     │ │ Balancer    │ │     │ │ Balancer    │ │
│ └──────┬──────┘ │     │ └──────┬──────┘ │     │ └──────┬──────┘ │
│        │        │     │        │        │     │        │        │
│ ┌──────┴──────┐ │     │ ┌──────┴──────┐ │     │ ┌──────┴──────┐ │
│ │   Otedama   │ │     │ │   Otedama   │ │     │ │   Otedama   │ │
│ │   Cluster   │ │◄────┼─┤   Cluster   │ │◄────┼─┤   Cluster   │ │
│ └─────────────┘ │     │ └─────────────┘ │     │ └─────────────┘ │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │                       │
         └───────────────────────┴───────────────────────┘
                         Global Database
```

### 2. Load Balancer Configuration (HAProxy)

```
global
    maxconn 100000
    log /dev/log local0
    stats socket /var/run/haproxy.sock mode 660
    tune.ssl.default-dh-param 2048

defaults
    mode tcp
    timeout connect 5s
    timeout client 30s
    timeout server 30s
    option tcplog

frontend mining_frontend
    bind *:3333
    default_backend mining_backend

backend mining_backend
    balance leastconn
    option tcp-check
    
    server pool1 10.0.1.10:3333 check weight 100
    server pool2 10.0.1.11:3333 check weight 100
    server pool3 10.0.1.12:3333 check weight 100
    
    # Backup servers
    server backup1 10.0.2.10:3333 backup
    server backup2 10.0.2.11:3333 backup
```

### 3. Database Replication

```bash
# Primary database setup
sudo -u postgres psql -c "CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'repl_password';"

# Configure primary
echo "wal_level = replica
max_wal_senders = 3
wal_keep_segments = 64" | sudo tee -a /etc/postgresql/14/main/postgresql.conf

# Configure replicas
pg_basebackup -h primary_host -D /var/lib/postgresql/14/main -U replicator -v -P -W

# Start replica
echo "standby_mode = 'on'
primary_conninfo = 'host=primary_host port=5432 user=replicator'" | sudo tee /var/lib/postgresql/14/main/recovery.conf
```

## Monitoring Setup

### 1. Prometheus Configuration

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'otedama'
    static_configs:
      - targets: ['localhost:9090']
    metrics_path: '/metrics'
    
  - job_name: 'node'
    static_configs:
      - targets: ['localhost:9100']
      
  - job_name: 'postgres'
    static_configs:
      - targets: ['localhost:9187']
```

### 2. Grafana Dashboard

Import the Otedama dashboard from `monitoring/grafana-dashboard.json`:

```bash
# API import
curl -X POST http://admin:admin@localhost:3000/api/dashboards/db \
  -H "Content-Type: application/json" \
  -d @monitoring/grafana-dashboard.json
```

### 3. Alerting Rules

```yaml
groups:
  - name: otedama_alerts
    interval: 30s
    rules:
      - alert: HighErrorRate
        expr: rate(otedama_errors_total[5m]) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: High error rate detected
          
      - alert: LowHashrate
        expr: otedama_pool_hashrate < 1000000000
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: Pool hashrate critically low
```

## Security Hardening

### 1. Firewall Rules

```bash
# Allow only necessary ports
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 3333/tcp
sudo ufw allow 8080/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### 2. SSL/TLS Configuration

```nginx
server {
    listen 443 ssl http2;
    server_name pool.example.com;
    
    ssl_certificate /etc/ssl/certs/otedama.crt;
    ssl_certificate_key /etc/ssl/private/otedama.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers off;
    
    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### 3. Security Headers

```javascript
// In otedama.config.js
security: {
  headers: {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'X-XSS-Protection': '1; mode=block',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy': "default-src 'self'"
  }
}
```

## Maintenance

### 1. Backup Strategy

```bash
#!/bin/bash
# Daily backup script

BACKUP_DIR="/backup/otedama/$(date +%Y%m%d)"
mkdir -p $BACKUP_DIR

# Database backup
pg_dump -U otedama otedama | gzip > $BACKUP_DIR/database.sql.gz

# Configuration backup
tar -czf $BACKUP_DIR/config.tar.gz /opt/otedama/config

# Data backup
rsync -av /opt/otedama/data/ $BACKUP_DIR/data/

# Cleanup old backups (keep 30 days)
find /backup/otedama -type d -mtime +30 -exec rm -rf {} \;
```

### 2. Updates and Upgrades

```bash
# Zero-downtime update process
# 1. Pull latest code
cd /opt/otedama
git pull origin main

# 2. Install dependencies
npm install --production

# 3. Run migrations
npm run migrate

# 4. Reload service
sudo systemctl reload otedama

# For Kubernetes
kubectl set image deployment/otedama-pool otedama=otedama:new-version -n otedama
kubectl rollout status deployment/otedama-pool -n otedama
```

### 3. Performance Tuning

```bash
# System optimization
echo "net.core.somaxconn = 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.ip_local_port_range = 1024 65535
fs.file-max = 1000000" | sudo tee -a /etc/sysctl.conf

sudo sysctl -p

# Database optimization
sudo -u postgres psql otedama -c "VACUUM ANALYZE;"
sudo -u postgres psql otedama -c "REINDEX DATABASE otedama;"
```

## Troubleshooting

### Common Issues

**Connection refused:**
```bash
# Check service status
sudo systemctl status otedama
# Check ports
sudo netstat -tlnp | grep 3333
```

**High memory usage:**
```bash
# Check memory
free -h
# Adjust Node.js memory
export NODE_OPTIONS="--max-old-space-size=4096"
```

**Database connection errors:**
```bash
# Check PostgreSQL
sudo systemctl status postgresql
# Check connections
sudo -u postgres psql -c "SELECT count(*) FROM pg_stat_activity;"
```

### Health Checks

```bash
# API health
curl http://localhost:8080/health

# Stratum health
echo '{"id":1,"method":"mining.subscribe","params":[]}' | nc localhost 3333

# Full system check
npm run health:check
```

## Support

For deployment assistance:
- Documentation: See `/docs` folder
- Issues: Submit via GitHub Issues
- Community: Join our forums for help