# Otedama Deployment Guide

## Overview

This guide covers deployment options for Otedama, from single-server setups to multi-region, high-availability configurations suitable for national-scale operations.

## Deployment Options

### 1. Single Server (Development/Small Scale)

**Requirements:**
- 4+ CPU cores
- 8GB+ RAM
- 100GB+ SSD
- Ubuntu 20.04+

**Quick Deploy:**
```bash
# Clone and setup
git clone [repository_url]
cd otedama
npm install

# Configure
cp .env.example .env
nano .env

# Start
npm run start:pool
```

### 2. Docker Deployment (Recommended)

**Requirements:**
- Docker 20.10+
- Docker Compose 2.0+

**Deploy:**
```bash
# Build and run
docker-compose -f docker-compose.production.yml up -d

# Scale workers
docker-compose scale worker=8

# View logs
docker-compose logs -f
```

### 3. Kubernetes Deployment (Enterprise)

**Requirements:**
- Kubernetes 1.22+
- Helm 3.0+
- Ingress controller
- Persistent storage

**Deploy:**
```bash
# Add Helm repository
helm repo add otedama https://charts.otedama.io
helm repo update

# Install with custom values
helm install otedama otedama/otedama \
  --namespace mining \
  --create-namespace \
  --values values.yaml
```

**values.yaml example:**
```yaml
replicaCount: 3

pool:
  name: "My Mining Pool"
  address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
  fee: 0.01

resources:
  limits:
    cpu: 4000m
    memory: 8Gi
  requests:
    cpu: 2000m
    memory: 4Gi

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70

persistence:
  enabled: true
  storageClass: "fast-ssd"
  size: 100Gi

ingress:
  enabled: true
  hosts:
    - pool.example.com
  tls:
    - secretName: pool-tls
      hosts:
        - pool.example.com
```

### 4. Multi-Region Deployment (National Scale)

**Architecture:**
```
┌─────────────────────────────────────────────────────────┐
│                    Global Load Balancer                  │
└────────────┬───────────────────────┬────────────────────┘
             │                       │
    ┌────────▼────────┐     ┌───────▼────────┐
    │  Region: US-E   │     │  Region: EU-W  │
    │  Primary Pool   │◄────┤ Replica Pool   │
    └────────┬────────┘     └───────┬────────┘
             │                       │
    ┌────────▼────────┐     ┌───────▼────────┐
    │   PostgreSQL    │     │   PostgreSQL   │
    │   Primary       │────►│   Replica      │
    └─────────────────┘     └────────────────┘
```

**Setup Primary Region:**
```bash
# Deploy primary
kubectl apply -f kubernetes/multi-region/primary/

# Configure geo-replication
kubectl exec -it postgres-primary -- psql -c "
  CREATE PUBLICATION otedama_pub FOR ALL TABLES;
"
```

**Setup Replica Regions:**
```bash
# Deploy replica
kubectl apply -f kubernetes/multi-region/replica/

# Configure subscription
kubectl exec -it postgres-replica -- psql -c "
  CREATE SUBSCRIPTION otedama_sub 
  CONNECTION 'host=primary.region1.example.com dbname=otedama' 
  PUBLICATION otedama_pub;
"
```

## Infrastructure as Code

### Terraform Configuration

**AWS Example:**
```hcl
# main.tf
provider "aws" {
  region = var.aws_region
}

module "otedama_pool" {
  source = "./modules/otedama"
  
  cluster_name    = "otedama-production"
  instance_type   = "m5.2xlarge"
  min_size        = 3
  max_size        = 20
  
  database = {
    instance_class = "db.r5.xlarge"
    storage_size   = 1000
    multi_az       = true
  }
  
  redis = {
    node_type = "cache.r6g.xlarge"
    num_nodes = 3
  }
  
  monitoring = {
    enable_cloudwatch = true
    enable_xray       = true
  }
}
```

### Ansible Playbook

**deploy.yml:**
```yaml
---
- name: Deploy Otedama Mining Pool
  hosts: pool_servers
  become: yes
  
  vars:
    otedama_version: "1.0.8"
    node_env: "production"
    
  tasks:
    - name: Install dependencies
      apt:
        name:
          - nodejs
          - npm
          - nginx
          - prometheus-node-exporter
        state: present
    
    - name: Clone Otedama
      git:
        repo: "{{ otedama_repo }}"
        dest: /opt/otedama
        version: "{{ otedama_version }}"
    
    - name: Install npm packages
      npm:
        path: /opt/otedama
        production: yes
    
    - name: Configure environment
      template:
        src: env.j2
        dest: /opt/otedama/.env
        mode: '0600'
    
    - name: Setup systemd service
      template:
        src: otedama.service.j2
        dest: /etc/systemd/system/otedama.service
    
    - name: Start Otedama
      systemd:
        name: otedama
        state: started
        enabled: yes
        daemon_reload: yes
```

## Security Hardening

### 1. Network Security

**Firewall Rules:**
```bash
# Allow only required ports
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp          # SSH
ufw allow 3333/tcp        # Stratum
ufw allow 3336/tcp        # Stratum V2
ufw allow 8080/tcp        # API
ufw allow 8333/tcp        # P2P
ufw enable
```

**Nginx Configuration:**
```nginx
server {
    listen 443 ssl http2;
    server_name pool.example.com;
    
    ssl_certificate /etc/letsencrypt/live/pool.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pool.example.com/privkey.pem;
    
    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    
    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
    limit_req zone=api burst=20 nodelay;
    
    location /api {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### 2. Database Security

**PostgreSQL Hardening:**
```sql
-- Create dedicated user
CREATE USER otedama WITH ENCRYPTED PASSWORD 'secure_password';
GRANT CONNECT ON DATABASE otedama TO otedama;
GRANT USAGE ON SCHEMA public TO otedama;
GRANT CREATE ON SCHEMA public TO otedama;

-- Enable SSL
ALTER SYSTEM SET ssl = on;
ALTER SYSTEM SET ssl_cert_file = '/etc/postgresql/server.crt';
ALTER SYSTEM SET ssl_key_file = '/etc/postgresql/server.key';

-- Audit logging
ALTER SYSTEM SET log_statement = 'all';
ALTER SYSTEM SET log_connections = on;
ALTER SYSTEM SET log_disconnections = on;
```

### 3. Application Security

**Environment Variables:**
```bash
# .env.production
NODE_ENV=production
POOL_NAME=Otedama Production

# Security
JWT_SECRET=$(openssl rand -base64 32)
API_KEY=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)

# TLS
TLS_ENABLED=true
TLS_CERT=/etc/ssl/certs/otedama.crt
TLS_KEY=/etc/ssl/private/otedama.key

# Security headers
HELMET_ENABLED=true
CORS_ORIGIN=https://pool.example.com

# Rate limiting
RATE_LIMIT_WINDOW=60000
RATE_LIMIT_MAX=1000
```

## Monitoring Setup

### 1. Prometheus Configuration

**prometheus.yml:**
```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'otedama'
    static_configs:
      - targets: ['localhost:9090']
    
  - job_name: 'node'
    static_configs:
      - targets: ['localhost:9100']
    
  - job_name: 'postgres'
    static_configs:
      - targets: ['localhost:9187']

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['localhost:9093']

rule_files:
  - 'alerts.yml'
```

**alerts.yml:**
```yaml
groups:
  - name: otedama
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

### 2. Grafana Dashboard

Import the Otedama dashboard:
```bash
# Import dashboard
curl -X POST http://admin:admin@localhost:3000/api/dashboards/db \
  -H "Content-Type: application/json" \
  -d @monitoring/grafana/otedama-dashboard.json
```

## Backup and Recovery

### 1. Automated Backups

**backup.sh:**
```bash
#!/bin/bash
# Otedama backup script

BACKUP_DIR="/backup/otedama"
DATE=$(date +%Y%m%d_%H%M%S)

# Database backup
pg_dump otedama | gzip > "$BACKUP_DIR/db_$DATE.sql.gz"

# Configuration backup
tar -czf "$BACKUP_DIR/config_$DATE.tar.gz" \
  /opt/otedama/.env \
  /opt/otedama/otedama.config.js

# Data directory backup
tar -czf "$BACKUP_DIR/data_$DATE.tar.gz" \
  /opt/otedama/data/

# Upload to S3
aws s3 sync "$BACKUP_DIR" s3://otedama-backups/

# Cleanup old backups (keep 30 days)
find "$BACKUP_DIR" -mtime +30 -delete
```

**Cron job:**
```bash
# Run backup every 6 hours
0 */6 * * * /opt/otedama/scripts/backup.sh
```

### 2. Disaster Recovery

**Recovery procedure:**
```bash
# 1. Stop services
systemctl stop otedama

# 2. Restore database
gunzip < /backup/db_latest.sql.gz | psql otedama

# 3. Restore configuration
tar -xzf /backup/config_latest.tar.gz -C /

# 4. Restore data
tar -xzf /backup/data_latest.tar.gz -C /

# 5. Start services
systemctl start otedama

# 6. Verify
curl http://localhost:8080/health
```

## Performance Tuning

### 1. System Optimization

**sysctl.conf:**
```bash
# Network performance
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
net.ipv4.tcp_rmem = 4096 87380 134217728
net.ipv4.tcp_wmem = 4096 65536 134217728
net.core.netdev_max_backlog = 5000
net.ipv4.tcp_congestion_control = bbr

# File descriptors
fs.file-max = 2097152

# Swap
vm.swappiness = 10
```

### 2. Node.js Optimization

**Start script:**
```bash
#!/bin/bash
# Optimized Node.js startup

export NODE_ENV=production
export UV_THREADPOOL_SIZE=16
export NODE_OPTIONS="--max-old-space-size=8192 --max-semi-space-size=512"

# CPU affinity for multi-core
taskset -c 0-15 node --enable-source-maps start-mining-pool.js
```

### 3. Database Tuning

**postgresql.conf:**
```ini
# Memory
shared_buffers = 8GB
effective_cache_size = 24GB
work_mem = 64MB
maintenance_work_mem = 2GB

# Connections
max_connections = 1000
max_prepared_transactions = 100

# Write performance
checkpoint_segments = 64
checkpoint_completion_target = 0.9
wal_buffers = 16MB

# Query optimization
random_page_cost = 1.1
effective_io_concurrency = 200
```

## Health Checks

### Kubernetes Probes

```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 8080
  initialDelaySeconds: 30
  periodSeconds: 10
  
readinessProbe:
  httpGet:
    path: /health/ready
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 5
  
startupProbe:
  httpGet:
    path: /health/startup
    port: 8080
  failureThreshold: 30
  periodSeconds: 10
```

### Custom Health Endpoints

```javascript
// Health check implementation
app.get('/health/live', (req, res) => {
  res.json({ status: 'alive' });
});

app.get('/health/ready', async (req, res) => {
  const checks = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkBlockchain()
  ]);
  
  const ready = checks.every(c => c.healthy);
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not ready',
    checks
  });
});
```

## Troubleshooting

### Common Issues

1. **High Memory Usage**
   ```bash
   # Check memory usage
   node --inspect=0.0.0.0:9229 start-mining-pool.js
   
   # Generate heap snapshot
   kill -USR2 $(pgrep -f otedama)
   ```

2. **Connection Limits**
   ```bash
   # Check current limits
   ulimit -n
   
   # Increase limits
   echo "* soft nofile 1048576" >> /etc/security/limits.conf
   echo "* hard nofile 1048576" >> /etc/security/limits.conf
   ```

3. **Database Performance**
   ```sql
   -- Check slow queries
   SELECT query, calls, mean_exec_time
   FROM pg_stat_statements
   ORDER BY mean_exec_time DESC
   LIMIT 10;
   
   -- Check table bloat
   SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
   FROM pg_tables
   ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
   ```

## Maintenance

### Rolling Updates

```bash
# Kubernetes rolling update
kubectl set image deployment/otedama otedama=otedama:1.0.9 --record

# Monitor rollout
kubectl rollout status deployment/otedama

# Rollback if needed
kubectl rollout undo deployment/otedama
```

### Database Maintenance

```bash
# Weekly maintenance script
#!/bin/bash

# Vacuum and analyze
psql otedama -c "VACUUM ANALYZE;"

# Reindex
psql otedama -c "REINDEX DATABASE otedama;"

# Update statistics
psql otedama -c "ANALYZE;"
```

## Compliance

### Audit Logging

Ensure all deployments include:

1. **Transaction logging**: All financial transactions
2. **Access logging**: API and admin access
3. **Security logging**: Failed auth, attacks
4. **Compliance reporting**: Automated reports

### Data Retention

Configure based on jurisdiction:

```javascript
// config/compliance.js
export const retention = {
  US: {
    auditLogs: 7 * 365, // 7 years
    transactions: 5 * 365, // 5 years
    userdata: 3 * 365 // 3 years
  },
  EU: {
    auditLogs: 10 * 365, // 10 years
    transactions: 10 * 365, // 10 years
    userdata: 'until_deletion_request'
  }
};
```