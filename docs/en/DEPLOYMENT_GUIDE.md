# Otedama Deployment Guide

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Local Development](#local-development)
3. [Docker Deployment](#docker-deployment)
4. [Kubernetes Deployment](#kubernetes-deployment)
5. [Cloud Deployment](#cloud-deployment)
6. [Production Deployment](#production-deployment)
7. [Monitoring Setup](#monitoring-setup)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### System Requirements
- **OS**: Linux (Ubuntu 20.04+), macOS, Windows (WSL2)
- **CPU**: 4+ cores recommended
- **RAM**: 8GB minimum, 16GB+ recommended
- **Storage**: 100GB+ SSD recommended
- **Network**: Stable internet, open ports for P2P

### Software Requirements
```bash
# Go 1.21+
wget https://go.dev/dl/go1.21.0.linux-amd64.tar.gz
sudo tar -C /usr/local -xzf go1.21.0.linux-amd64.tar.gz
export PATH=$PATH:/usr/local/go/bin

# Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# PostgreSQL Client
sudo apt-get install postgresql-client
```

---

## Local Development

### 1. Clone Repository
```bash
git clone https://github.com/shizukutanaka/Otedama.git
cd Otedama
```

### 2. Install Dependencies
```bash
go mod download
go mod verify
```

### 3. Configuration
```bash
# Copy example configuration
cp config/config.example.yaml config/config.yaml

# Edit configuration
nano config/config.yaml
```

#### Basic Configuration
```yaml
# config/config.yaml
server:
  host: "0.0.0.0"
  port: 8080
  mode: "development"

database:
  type: "postgres"
  host: "localhost"
  port: 5432
  name: "otedama"
  user: "otedama_user"
  password: "secure_password"

mining:
  algorithm: "sha256"
  difficulty: 4
  threads: 4

p2p:
  listen_addr: "0.0.0.0:19333"
  bootstrap_nodes:
    - "node1.otedama.network:19333"
    - "node2.otedama.network:19333"

dex:
  enabled: true
  fee_percentage: 0.3

defi:
  staking_enabled: true
  lending_enabled: true
```

### 4. Database Setup
```bash
# Start PostgreSQL
docker run -d \
  --name otedama-db \
  -e POSTGRES_USER=otedama_user \
  -e POSTGRES_PASSWORD=secure_password \
  -e POSTGRES_DB=otedama \
  -p 5432:5432 \
  postgres:14

# Run migrations
go run cmd/migrate/main.go up
```

### 5. Build and Run
```bash
# Build
go build -o otedama cmd/otedama/main.go

# Run
./otedama --config config/config.yaml
```

---

## Docker Deployment

### 1. Build Docker Image
```bash
# Production build
docker build -f Dockerfile.production -t otedama:latest .

# Development build
docker build -f Dockerfile -t otedama:dev .
```

### 2. Docker Compose Setup
```yaml
# docker-compose.yml
version: '3.8'

services:
  otedama:
    image: otedama:latest
    container_name: otedama-app
    ports:
      - "8080:8080"
      - "19333:19333"
      - "3333:3333"
    environment:
      - CONFIG_PATH=/app/config/config.yaml
      - LOG_LEVEL=info
    volumes:
      - ./config:/app/config
      - ./data:/app/data
    depends_on:
      - postgres
      - redis
    networks:
      - otedama-network

  postgres:
    image: postgres:14
    container_name: otedama-db
    environment:
      - POSTGRES_USER=otedama_user
      - POSTGRES_PASSWORD=secure_password
      - POSTGRES_DB=otedama
    volumes:
      - postgres-data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    networks:
      - otedama-network

  redis:
    image: redis:7-alpine
    container_name: otedama-cache
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    networks:
      - otedama-network

  prometheus:
    image: prom/prometheus:latest
    container_name: otedama-prometheus
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus-data:/prometheus
    ports:
      - "9090:9090"
    networks:
      - otedama-network

  grafana:
    image: grafana/grafana:latest
    container_name: otedama-grafana
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana-data:/var/lib/grafana
      - ./monitoring/grafana:/etc/grafana/provisioning
    ports:
      - "3000:3000"
    networks:
      - otedama-network

volumes:
  postgres-data:
  redis-data:
  prometheus-data:
  grafana-data:

networks:
  otedama-network:
    driver: bridge
```

### 3. Start Services
```bash
# Start all services
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f otedama
```

---

## Kubernetes Deployment

### 1. Namespace Setup
```yaml
# k8s/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: otedama
```

### 2. ConfigMap
```yaml
# k8s/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otedama-config
  namespace: otedama
data:
  config.yaml: |
    server:
      host: "0.0.0.0"
      port: 8080
    database:
      type: "postgres"
      host: "postgres-service"
      port: 5432
    # ... rest of config
```

### 3. Deployment
```yaml
# k8s/deployment.yaml
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
        - containerPort: 8080
        - containerPort: 19333
        - containerPort: 3333
        env:
        - name: CONFIG_PATH
          value: /app/config/config.yaml
        volumeMounts:
        - name: config
          mountPath: /app/config
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
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
```

### 4. Service
```yaml
# k8s/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: otedama-service
  namespace: otedama
spec:
  selector:
    app: otedama
  ports:
  - name: http
    port: 8080
    targetPort: 8080
  - name: p2p
    port: 19333
    targetPort: 19333
  - name: stratum
    port: 3333
    targetPort: 3333
  type: LoadBalancer
```

### 5. Deploy to Kubernetes
```bash
# Apply configurations
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml

# Check status
kubectl get pods -n otedama
kubectl get services -n otedama

# View logs
kubectl logs -f deployment/otedama -n otedama
```

---

## Cloud Deployment

### AWS Deployment

#### 1. EC2 Setup
```bash
# Launch EC2 instance (t3.xlarge recommended)
aws ec2 run-instances \
  --image-id ami-0c55b159cbfafe1f0 \
  --instance-type t3.xlarge \
  --key-name your-key \
  --security-group-ids sg-xxxxxx \
  --subnet-id subnet-xxxxxx

# SSH to instance
ssh -i your-key.pem ubuntu@ec2-instance-ip
```

#### 2. Install Dependencies
```bash
# Update system
sudo apt-get update && sudo apt-get upgrade -y

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Install Go
wget https://go.dev/dl/go1.21.0.linux-amd64.tar.gz
sudo tar -C /usr/local -xzf go1.21.0.linux-amd64.tar.gz
```

#### 3. Deploy Application
```bash
# Clone repository
git clone https://github.com/shizukutanaka/Otedama.git
cd Otedama

# Build and run with Docker
docker build -f Dockerfile.production -t otedama:latest .
docker run -d \
  --name otedama \
  -p 8080:8080 \
  -p 19333:19333 \
  -p 3333:3333 \
  -v $(pwd)/config:/app/config \
  -v $(pwd)/data:/app/data \
  otedama:latest
```

### Google Cloud Platform

#### 1. Create GKE Cluster
```bash
# Create cluster
gcloud container clusters create otedama-cluster \
  --zone us-central1-a \
  --num-nodes 3 \
  --machine-type n1-standard-4

# Get credentials
gcloud container clusters get-credentials otedama-cluster \
  --zone us-central1-a
```

#### 2. Deploy to GKE
```bash
# Build and push image
docker build -t gcr.io/your-project/otedama:latest .
docker push gcr.io/your-project/otedama:latest

# Deploy
kubectl apply -f k8s/
```

### Azure Deployment

#### 1. Create AKS Cluster
```bash
# Create resource group
az group create --name otedama-rg --location eastus

# Create AKS cluster
az aks create \
  --resource-group otedama-rg \
  --name otedama-cluster \
  --node-count 3 \
  --node-vm-size Standard_D4s_v3

# Get credentials
az aks get-credentials \
  --resource-group otedama-rg \
  --name otedama-cluster
```

---

## Production Deployment

### 1. Environment Variables
```bash
# .env.production
NODE_ENV=production
LOG_LEVEL=info
DATABASE_URL=postgresql://user:pass@host:5432/otedama
REDIS_URL=redis://redis:6379
SECRET_KEY=your-secret-key
JWT_SECRET=your-jwt-secret
```

### 2. SSL/TLS Configuration
```nginx
# nginx.conf
server {
    listen 443 ssl http2;
    server_name otedama.local;

    ssl_certificate /etc/ssl/certs/otedama.crt;
    ssl_certificate_key /etc/ssl/private/otedama.key;

    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### 3. Systemd Service
```ini
# /etc/systemd/system/otedama.service
[Unit]
Description=Otedama P2P Mining Pool
After=network.target

[Service]
Type=simple
User=otedama
WorkingDirectory=/opt/otedama
ExecStart=/opt/otedama/otedama --config /opt/otedama/config/config.yaml
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### 4. Start Service
```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable and start service
sudo systemctl enable otedama
sudo systemctl start otedama

# Check status
sudo systemctl status otedama
```

---

## Monitoring Setup

### 1. Prometheus Configuration
```yaml
# monitoring/prometheus.yml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'otedama'
    static_configs:
      - targets: ['otedama:8080']
    metrics_path: '/metrics'
```

### 2. Grafana Dashboard
Import dashboard JSON from `monitoring/grafana/dashboards/otedama.json`

### 3. Alerts Configuration
```yaml
# monitoring/alerts.yml
groups:
  - name: otedama
    rules:
      - alert: HighErrorRate
        expr: rate(otedama_errors_total[5m]) > 0.05
        for: 10m
        annotations:
          summary: High error rate detected
      
      - alert: LowHashrate
        expr: otedama_hashrate < 1000000
        for: 15m
        annotations:
          summary: Low hashrate detected
```

---

## Troubleshooting

### Common Issues

#### 1. Database Connection Failed
```bash
# Check PostgreSQL status
docker ps | grep postgres

# Test connection
psql -h localhost -U otedama_user -d otedama

# Check logs
docker logs otedama-db
```

#### 2. P2P Connection Issues
```bash
# Check firewall rules
sudo ufw status

# Open P2P port
sudo ufw allow 19333/tcp

# Test P2P connectivity
telnet node1.otedama.network 19333
```

#### 3. High Memory Usage
```bash
# Check memory usage
docker stats otedama

# Adjust memory limits in docker-compose.yml
# or set GOGC environment variable
export GOGC=50
```

#### 4. Mining Not Working
```bash
# Check mining status
curl http://localhost:8080/api/mining/status

# Check worker connections
curl http://localhost:8080/api/workers

# View mining logs
docker logs otedama | grep mining
```

### Debug Mode
```bash
# Run with debug logging
./otedama --config config/config.yaml --log-level debug

# Enable profiling
./otedama --config config/config.yaml --profile
```

### Support

- **GitHub Issues**: https://github.com/shizukutanaka/Otedama/issues
- **Documentation**: ./README.md

---

*For production deployments, always follow security best practices and conduct thorough testing before going live.*