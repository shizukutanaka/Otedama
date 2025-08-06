# Otedama Enterprise P2P Mining Pool - Production Deployment Guide

**Version**: 2.1.5  
**Last Updated**: 2025-08-06  

## Prerequisites

- Go 1.21 or higher
- PostgreSQL 14 or higher  
- Redis 7.0 or higher (for caching and session management)
- Docker 24.0+ and Docker Compose v2 (for containerized deployment)
- Kubernetes 1.28+ (for enterprise deployment)
- SSL certificates for HTTPS/TLS
- Hardware Security Module (HSM) support (optional, for enterprise security)

## System Requirements

### Minimum Requirements (Development)
- CPU: 4 cores (3.0GHz+)
- RAM: 16GB DDR4
- Storage: 200GB NVMe SSD
- Network: 1 Gbps with low latency

### Production Requirements
- CPU: 16+ cores (3.2GHz+, Intel Xeon or AMD EPYC)
- RAM: 64GB+ DDR4 ECC
- Storage: 1TB+ NVMe SSD RAID 1
- Network: 10 Gbps with redundancy
- GPU: Optional RTX 4090 or AMD RX 7900 XTX for optimization testing

### Enterprise/National-Level Requirements  
- CPU: 32+ cores across multiple nodes
- RAM: 128GB+ per node
- Storage: 5TB+ distributed storage (Ceph/GlusterFS)
- Network: 25+ Gbps with DDoS protection
- Load Balancers: Hardware load balancers (F5, Citrix)
- High Availability: Multi-region deployment

## Installation Steps

### 1. Prepare Environment
```bash
# Create otedama user and directories
sudo useradd -r -s /bin/false otedama
sudo mkdir -p /opt/otedama/{bin,config,data,logs}
sudo chown -R otedama:otedama /opt/otedama

# Navigate to installation directory
cd /opt/otedama
```

### 2. Build from Source
```bash
# Build optimized production binary
make build-production

# Or build manually with optimizations
CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build \
  -ldflags="-s -w -X main.version=$(cat VERSION)" \
  -tags="production" \
  -o bin/otedama cmd/otedama/main.go

# Verify binary
./bin/otedama version
```

### 3. Install Dependencies
```bash
# Download Go modules
go mod download
go mod verify

# Install additional tools for production
go install github.com/golang-migrate/migrate/v4/cmd/migrate@latest
go install github.com/air-verse/air@latest  # For development hot reload
```

### 4. Database Setup

Create PostgreSQL database with enterprise features:
```sql
-- Create database and user
CREATE DATABASE otedama WITH 
  ENCODING 'UTF8'
  LC_COLLATE 'en_US.UTF-8'
  LC_CTYPE 'en_US.UTF-8';

CREATE USER otedama_user WITH 
  ENCRYPTED PASSWORD 'your_secure_password'
  CREATEDB CREATEROLE;

GRANT ALL PRIVILEGES ON DATABASE otedama TO otedama_user;

-- Enable required extensions
\c otedama;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
```

Run database migrations:
```bash
# Set database URL
export DATABASE_URL="postgresql://otedama_user:your_secure_password@localhost:5432/otedama?sslmode=require"

# Run migrations
./bin/otedama migrate up

# Verify migration status
./bin/otedama migrate status
```

### 5. Configuration

Copy production configuration template:
```bash
cp config.yaml config/production.yaml
```

Edit `config/production.yaml` with enterprise settings:
```yaml
# Application Configuration
app:
  name: "Otedama"
  mode: "production"
  version: "2.1.5"
  log_level: "info"

# Server Configuration
server:
  host: "0.0.0.0"
  port: 8080
  read_timeout: 30s
  write_timeout: 30s
  idle_timeout: 120s
  max_header_bytes: 1048576

# Mining Configuration
mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0  # Auto-detect
    priority: "normal"
    huge_pages: true
    numa_aware: true
  
  gpu:
    devices: []  # Auto-detect all
    intensity: 20
    temperature_limit: 85
    memory_optimization: true
  
  asic:
    devices: []  # Auto-discover
    poll_interval: 5s
    firmware_optimization: true

# Pool Configuration
pool:
  enable: true
  address: "0.0.0.0:3333"
  max_connections: 50000
  fee_percentage: 1.0
  minimum_payout: 0.001
  rewards:
    system: "PPLNS"
    window: 2h
    difficulty_adjustment: "auto"

# Stratum Configuration
stratum:
  enable: true
  address: "0.0.0.0:3333"
  max_workers: 50000
  job_timeout: 30s
  share_difficulty: 1
  var_diff: true
  protocols:
    v1: true
    v2: true

# API Configuration
api:
  enable: true
  address: "0.0.0.0:8080"
  cors_origins: ["*"]
  auth:
    enabled: true
    token_expiry: 24h
    rate_limiting: true
  
# Database Configuration  
database:
  host: "localhost"
  port: 5432
  name: "otedama"
  user: "otedama_user"
  password: "your_secure_password"
  ssl_mode: "require"
  max_connections: 200
  max_idle_connections: 50
  connection_max_lifetime: 1h

# Redis Configuration
redis:
  host: "localhost"
  port: 6379
  password: ""
  db: 0
  pool_size: 100

# Security Configuration
security:
  enable_tls: true
  cert_file: "/etc/ssl/certs/otedama.crt"
  key_file: "/etc/ssl/private/otedama.key"
  
  ddos_protection:
    enabled: true
    rate_limit: 1000
    burst_limit: 2000
    ban_duration: 3600s
    
  firewall:
    enabled: true
    whitelist: []
    blacklist: []
    
  audit:
    enabled: true
    log_file: "/opt/otedama/logs/audit.log"

# P2P Federation Configuration
federation:
  enabled: true
  node_id: "otedama-node-prod-001"
  listen_port: 4444
  bootstrap_peers:
    - "peer1.example.com:4444"
    - "peer2.example.com:4444"
  max_peers: 50
  reputation_threshold: 0.8

# Monitoring Configuration
monitoring:
  metrics:
    enabled: true
    address: "0.0.0.0:9090"
    path: "/metrics"
  
  health:
    enabled: true
    address: "0.0.0.0:8081"
    path: "/health"
  
  logging:
    level: "info"
    format: "json"
    file: "/opt/otedama/logs/otedama.log"
    max_size: 100
    max_backups: 10
    max_age: 30

# Hardware Optimization
optimization:
  enable_memory_timing: true
  memory_timing_level: 3
  enable_power_opt: true
  power_limit: 85
  enable_thermal_opt: true
  target_temp: 75
  enable_stratum_v2: true
  auto_optimize: true
  optimization_interval: 3600
  safety_mode: true
```

### 6. Test Configuration
```bash
# Validate configuration
./bin/otedama config validate --config config/production.yaml

# Test database connection
./bin/otedama config test-db --config config/production.yaml

# Perform system check
./bin/otedama system check
```

### 7. Start Application
```bash
# Start with specific config
./bin/otedama serve --config config/production.yaml

# Or use environment variable
export OTEDAMA_CONFIG=/opt/otedama/config/production.yaml
./bin/otedama serve
```

## Docker Production Deployment

### 1. Build Production Docker Image
```bash
# Build production image with optimizations
docker build -f Dockerfile.production -t otedama:production .

# Build with specific version tag
docker build -f Dockerfile.production -t otedama:v2.1.5 .

# Multi-arch build for ARM64/AMD64
docker buildx build --platform linux/amd64,linux/arm64 \
  -f Dockerfile.production -t otedama:v2.1.5 .
```

### 2. Production Docker Compose
```yaml
version: '3.8'

services:
  otedama:
    image: otedama:production
    container_name: otedama-pool
    restart: unless-stopped
    ports:
      - "3333:3333"   # SHA256d Stratum
      - "3334:3334"   # Ethash Stratum  
      - "3335:3335"   # RandomX Stratum
      - "3336:3336"   # KawPow Stratum
      - "3337:3337"   # Scrypt Stratum
      - "8080:8080"   # API/WebSocket
      - "4444:4444"   # P2P Federation
      - "9090:9090"   # Metrics
      - "8081:8081"   # Health Check
    environment:
      - OTEDAMA_MODE=production
      - DATABASE_URL=postgresql://otedama_user:${DB_PASSWORD}@db:5432/otedama?sslmode=require
      - REDIS_URL=redis://redis:6379/0
      - LOG_LEVEL=info
    volumes:
      - ./config/production.yaml:/app/config/config.yaml:ro
      - ./data:/app/data
      - ./logs:/app/logs
      - /etc/ssl/certs:/etc/ssl/certs:ro
      - /etc/ssl/private:/etc/ssl/private:ro
    depends_on:
      - db
      - redis
    networks:
      - otedama-network
    healthcheck:
      test: ["CMD", "/app/otedama", "health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
    deploy:
      resources:
        limits:
          cpus: '16'
          memory: 32G
        reservations:
          cpus: '8'
          memory: 16G

  db:
    image: postgres:15-alpine
    container_name: otedama-db
    restart: unless-stopped
    environment:
      - POSTGRES_DB=otedama
      - POSTGRES_USER=otedama_user
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_INITDB_ARGS=--encoding=UTF-8 --lc-collate=en_US.UTF-8 --lc-ctype=en_US.UTF-8
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./scripts/postgres-init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    networks:
      - otedama-network
    command: >
      postgres
      -c max_connections=500
      -c shared_buffers=256MB
      -c effective_cache_size=1GB
      -c maintenance_work_mem=64MB
      -c checkpoint_completion_target=0.9
      -c wal_buffers=16MB
      -c default_statistics_target=100
      -c random_page_cost=1.1
      -c effective_io_concurrency=200
      -c work_mem=4MB

  redis:
    image: redis:7-alpine
    container_name: otedama-redis
    restart: unless-stopped
    command: >
      redis-server
      --maxmemory 1gb
      --maxmemory-policy allkeys-lru
      --save 900 1
      --save 300 10
      --save 60 10000
    volumes:
      - redis_data:/data
    networks:
      - otedama-network

  prometheus:
    image: prom/prometheus:latest
    container_name: otedama-prometheus
    restart: unless-stopped
    ports:
      - "9091:9090"
    volumes:
      - ./config/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus_data:/prometheus
    networks:
      - otedama-network
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--web.console.libraries=/etc/prometheus/console_libraries'
      - '--web.console.templates=/etc/prometheus/consoles'
      - '--storage.tsdb.retention.time=200h'
      - '--web.enable-lifecycle'

  grafana:
    image: grafana/grafana:latest
    container_name: otedama-grafana
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_PASSWORD}
      - GF_USERS_ALLOW_SIGN_UP=false
    volumes:
      - grafana_data:/var/lib/grafana
      - ./config/grafana/dashboards:/etc/grafana/provisioning/dashboards:ro
      - ./config/grafana/datasources:/etc/grafana/provisioning/datasources:ro
    networks:
      - otedama-network

volumes:
  postgres_data:
    driver: local
  redis_data:
    driver: local
  prometheus_data:
    driver: local
  grafana_data:
    driver: local

networks:
  otedama-network:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/16
```

### 3. Environment Variables
Create `.env` file:
```bash
# Database
DB_PASSWORD=your_very_secure_database_password

# Grafana
GRAFANA_PASSWORD=your_grafana_admin_password

# SSL Certificates
SSL_CERT_PATH=/etc/ssl/certs/otedama.crt
SSL_KEY_PATH=/etc/ssl/private/otedama.key

# Production Settings
OTEDAMA_MODE=production
LOG_LEVEL=info
ENABLE_PROFILING=false
```

## Kubernetes Enterprise Deployment

### 1. Prepare Kubernetes Cluster
```bash
# Create namespace
kubectl create namespace otedama-production

# Apply network policies
kubectl apply -f k8s/network-policies.yaml

# Create secrets
kubectl create secret generic otedama-secrets \
  --from-literal=db-password=your_secure_password \
  --from-literal=api-key=your_api_key \
  --namespace=otedama-production
```

### 2. Deploy Infrastructure
```bash
# Deploy PostgreSQL with persistence
kubectl apply -f k8s/postgres-statefulset.yaml

# Deploy Redis cluster
kubectl apply -f k8s/redis-cluster.yaml

# Deploy monitoring stack
kubectl apply -f k8s/monitoring/
```

### 3. Deploy Otedama
```bash
# Deploy complete stack
kubectl apply -f k8s/

# Wait for rollout
kubectl rollout status deployment/otedama-deployment -n otedama-production

# Check pod status
kubectl get pods -n otedama-production
```

### 4. Configure Load Balancer
```yaml
# k8s/load-balancer.yaml
apiVersion: v1
kind: Service
metadata:
  name: otedama-loadbalancer
  namespace: otedama-production
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
    service.beta.kubernetes.io/aws-load-balancer-backend-protocol: "tcp"
spec:
  type: LoadBalancer
  selector:
    app: otedama
  ports:
  - name: stratum-sha256d
    port: 3333
    targetPort: 3333
    protocol: TCP
  - name: stratum-ethash
    port: 3334
    targetPort: 3334
    protocol: TCP
  - name: api
    port: 443
    targetPort: 8080
    protocol: TCP
  - name: federation
    port: 4444
    targetPort: 4444
    protocol: TCP
```

## Production Deployment (Bare Metal)

### 1. System Optimization

Add to `/etc/sysctl.conf`:
```bash
# Network optimizations for high-performance mining
net.core.rmem_max = 268435456
net.core.wmem_max = 268435456
net.ipv4.tcp_rmem = 8192 131072 268435456
net.ipv4.tcp_wmem = 8192 131072 268435456
net.core.netdev_max_backlog = 30000
net.ipv4.tcp_congestion_control = bbr
net.ipv4.tcp_max_syn_backlog = 30000
net.core.somaxconn = 32768
net.ipv4.tcp_max_tw_buckets = 2000000
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 10
net.ipv4.tcp_slow_start_after_idle = 0

# File descriptor and process limits
fs.file-max = 2097152
fs.nr_open = 2097152
kernel.pid_max = 2097152

# Memory management for mining workloads
vm.swappiness = 1
vm.dirty_ratio = 10
vm.dirty_background_ratio = 5
vm.vfs_cache_pressure = 50

# Huge pages for CPU mining optimization
vm.nr_hugepages = 128
kernel.shmmax = 68719476736
kernel.shmall = 4294967296
```

Apply changes and configure limits:
```bash
# Apply sysctl changes
sysctl -p

# Set ulimits in /etc/security/limits.conf
echo "otedama soft nofile 1048576" >> /etc/security/limits.conf
echo "otedama hard nofile 1048576" >> /etc/security/limits.conf
echo "otedama soft nproc 1048576" >> /etc/security/limits.conf
echo "otedama hard nproc 1048576" >> /etc/security/limits.conf

# Enable hugepages
echo 'echo never > /sys/kernel/mm/transparent_hugepage/enabled' >> /etc/rc.local
echo 'echo never > /sys/kernel/mm/transparent_hugepage/defrag' >> /etc/rc.local
```

### 2. Systemd Service

Create `/etc/systemd/system/otedama.service`:
```ini
[Unit]
Description=Otedama Enterprise P2P Mining Pool
Documentation=https://docs.otedama.io
After=network-online.target postgresql.service redis.service
Wants=network-online.target
Requires=postgresql.service redis.service

[Service]
Type=notify
User=otedama
Group=otedama
WorkingDirectory=/opt/otedama
Environment=OTEDAMA_CONFIG=/opt/otedama/config/production.yaml
Environment=GOMAXPROCS=16
ExecStartPre=/opt/otedama/bin/otedama config validate
ExecStart=/opt/otedama/bin/otedama serve
ExecReload=/bin/kill -HUP $MAINPID
KillMode=mixed
KillSignal=SIGTERM
TimeoutStartSec=300
TimeoutStopSec=120
Restart=always
RestartSec=10

# Security settings
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/otedama/data /opt/otedama/logs

# Resource limits
LimitNOFILE=2097152
LimitNPROC=2097152
LimitCORE=0

# Performance settings
Nice=-10
IOSchedulingClass=1
IOSchedulingPriority=4

[Install]
WantedBy=multi-user.target
```

Create additional service for backup:
```ini
# /etc/systemd/system/otedama-backup.service
[Unit]
Description=Otedama Backup Service
After=otedama.service

[Service]
Type=oneshot
User=otedama
Group=otedama
ExecStart=/opt/otedama/scripts/backup.sh
```

Create backup timer:
```ini
# /etc/systemd/system/otedama-backup.timer
[Unit]
Description=Otedama Backup Timer
Requires=otedama-backup.service

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable and start services:
```bash
# Main service
sudo systemctl daemon-reload
sudo systemctl enable otedama
sudo systemctl start otedama

# Backup service
sudo systemctl enable otedama-backup.timer
sudo systemctl start otedama-backup.timer

# Check status
sudo systemctl status otedama
sudo systemctl status otedama-backup.timer
```

### 3. Nginx Reverse Proxy

```nginx
upstream otedama_api {
    server 127.0.0.1:8080;
    keepalive 32;
}

server {
    listen 80;
    server_name pool.example.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name pool.example.com;

    ssl_certificate /etc/ssl/certs/pool.example.com.crt;
    ssl_certificate_key /etc/ssl/private/pool.example.com.key;
    
    # API endpoints
    location /api/ {
        proxy_pass http://otedama_api;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
    
    # WebSocket support
    location /ws {
        proxy_pass http://otedama_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
    
    # Static files
    location / {
        root /opt/otedama/web;
        try_files $uri $uri/ /index.html;
    }
}
```

### 4. Monitoring Setup

#### Prometheus Configuration
```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'otedama'
    static_configs:
      - targets: ['localhost:8080']
```

#### Grafana Dashboard
Import the provided dashboard from `monitoring/grafana-dashboard.json`

### 5. Backup Configuration

Create backup script `/opt/otedama/backup.sh`:
```bash
#!/bin/bash
BACKUP_DIR="/backup/otedama"
DATE=$(date +%Y%m%d_%H%M%S)

# Database backup
pg_dump -U otedama_user otedama > $BACKUP_DIR/db_$DATE.sql

# Configuration backup
tar -czf $BACKUP_DIR/config_$DATE.tar.gz /opt/otedama/config.yaml

# Upload to S3 (optional)
aws s3 sync $BACKUP_DIR s3://your-backup-bucket/otedama/
```

Add to crontab:
```bash
0 2 * * * /opt/otedama/backup.sh
```

## Security Hardening

### 1. Firewall Rules
```bash
# Allow mining ports
ufw allow 3333/tcp
ufw allow 3334/tcp
ufw allow 3335/tcp

# Allow API/Web
ufw allow 80/tcp
ufw allow 443/tcp

# Allow federation
ufw allow 4444/tcp

# Enable firewall
ufw enable
```

### 2. SSL/TLS Configuration
Use Let's Encrypt for free SSL certificates:
```bash
certbot certonly --standalone -d pool.example.com
```

### 3. DDoS Protection
Configure Cloudflare or similar CDN for additional DDoS protection.

## Maintenance

### Log Rotation
Create `/etc/logrotate.d/otedama`:
```
/var/log/otedama/*.log {
    daily
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 otedama otedama
    postrotate
        systemctl reload otedama
    endscript
}
```

### Database Maintenance
```bash
# Vacuum and analyze
psql -U otedama_user -d otedama -c "VACUUM ANALYZE;"

# Reindex
psql -U otedama_user -d otedama -c "REINDEX DATABASE otedama;"
```

## Troubleshooting

### Check Logs
```bash
journalctl -u otedama -f
tail -f /var/log/otedama/error.log
```

### Common Issues

1. **Port Already in Use**
   ```bash
   lsof -i :3333
   kill -9 <PID>
   ```

2. **Database Connection Failed**
   - Check PostgreSQL is running
   - Verify credentials in config.yaml
   - Check pg_hba.conf for authentication

3. **High Memory Usage**
   - Adjust worker pool size in config
   - Enable memory profiling
   - Check for memory leaks

### Performance Tuning

1. **Database Optimization**
   ```sql
   -- Add indexes
   CREATE INDEX idx_shares_user_timestamp ON shares(user_id, timestamp);
   CREATE INDEX idx_blocks_found_at ON blocks(found_at);
   ```

2. **Connection Pool Tuning**
   Adjust in config.yaml based on load:
   ```yaml
   database:
     max_connections: 200
     max_idle_connections: 20
     connection_max_lifetime: 1h
   ```

## Enterprise Support & Monitoring

### Health Checks
```bash
# System health check
curl -f http://localhost:8081/health || exit 1

# API availability check
curl -f http://localhost:8080/api/status || exit 1

# Database connectivity check
./bin/otedama config test-db

# Mining engine status
./bin/otedama mining status

# P2P federation health
./bin/otedama federation status
```

### Performance Monitoring
```bash
# Check real-time metrics
curl http://localhost:9090/metrics | grep otedama

# Monitor resource usage
htop -p $(pgrep otedama)

# Check mining statistics
./bin/otedama stats --format json

# Monitor network connections
ss -tuln | grep :3333
```

### Log Analysis
```bash
# Real-time logs
journalctl -u otedama -f

# Error analysis
grep ERROR /opt/otedama/logs/otedama.log | tail -100

# Performance analysis
grep "optimization" /opt/otedama/logs/otedama.log

# Security events
grep "security" /opt/otedama/logs/audit.log
```

## Production Deployment Checklist

### Pre-Deployment
- [ ] Hardware requirements verified
- [ ] System optimizations applied
- [ ] Database setup completed with proper indexes
- [ ] SSL certificates installed and validated
- [ ] Security hardening implemented
- [ ] Backup strategy configured and tested
- [ ] Monitoring and alerting setup
- [ ] Load balancer configured (if applicable)
- [ ] Firewall rules implemented
- [ ] Performance benchmarks executed

### Post-Deployment
- [ ] Health checks passing
- [ ] All mining algorithms functioning
- [ ] P2P federation synchronized
- [ ] API endpoints responding correctly
- [ ] WebSocket connections working
- [ ] Metrics collection operational
- [ ] Log rotation configured
- [ ] Backup automation tested
- [ ] Security audit completed
- [ ] Performance optimization verified

### Maintenance Schedule
- **Daily**: Health checks, log review, backup verification
- **Weekly**: Performance analysis, security scan, database maintenance
- **Monthly**: Security audit, dependency updates, capacity planning
- **Quarterly**: Disaster recovery test, configuration review

## Support & Documentation

### Technical Support
- **Documentation**: Review `/opt/otedama/docs/` directory
- **Configuration**: Validate with `./bin/otedama config validate`
- **API Reference**: Access `/api/docs` when running

### Troubleshooting Resources
```bash
# Generate system report
./bin/otedama system report > system-report.txt

# Export configuration (sanitized)
./bin/otedama config export --sanitize > config-export.yaml

# Create debug bundle
./bin/otedama debug bundle --output debug-bundle.tar.gz
```

### Performance Optimization
- **CPU Mining**: Enable huge pages, NUMA awareness
- **GPU Mining**: Memory timing optimization, thermal management
- **ASIC Mining**: Firmware optimization, power efficiency tuning
- **Network**: TCP BBR, connection pooling, load balancing
- **Database**: Connection pooling, query optimization, indexing
- **Federation**: Peer selection, reputation management

---

**Deployment Guide Version**: v2.1.5  
**Last Updated**: 2025-01-15  
**Target Environment**: Production Enterprise