#!/bin/bash

# Production Deployment Script for Otedama Mining Pool
# This script automates the complete deployment of Otedama for commercial use

set -euo pipefail

# Configuration
DEPLOYMENT_TYPE="${1:-docker}"  # docker, kubernetes, or bare-metal
ENVIRONMENT="${2:-production}"
VERSION="${3:-latest}"
DOMAIN="${4:-otedama.io}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}"
}

warn() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $1${NC}"
}

error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $1${NC}"
    exit 1
}

# Check prerequisites
check_prerequisites() {
    log "Checking prerequisites..."
    
    case $DEPLOYMENT_TYPE in
        docker)
            command -v docker >/dev/null 2>&1 || error "Docker is not installed"
            command -v docker-compose >/dev/null 2>&1 || error "Docker Compose is not installed"
            ;;
        kubernetes)
            command -v kubectl >/dev/null 2>&1 || error "kubectl is not installed"
            command -v helm >/dev/null 2>&1 || error "Helm is not installed"
            ;;
        bare-metal)
            command -v node >/dev/null 2>&1 || error "Node.js is not installed"
            command -v npm >/dev/null 2>&1 || error "npm is not installed"
            ;;
    esac
    
    log "Prerequisites check passed"
}

# Setup environment
setup_environment() {
    log "Setting up environment..."
    
    # Create necessary directories
    mkdir -p {data,logs,backups,ssl,config}
    
    # Set correct permissions
    chmod 755 {data,logs,backups,ssl,config}
    
    # Generate SSL certificates if not exist
    if [ ! -f "ssl/cert.pem" ]; then
        log "Generating SSL certificates..."
        openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
            -keyout ssl/key.pem -out ssl/cert.pem \
            -subj "/C=US/ST=State/L=City/O=Otedama/CN=${DOMAIN}"
    fi
    
    # Copy production configuration
    cp config/production.json config/active.json
    
    # Set environment variables
    export NODE_ENV=${ENVIRONMENT}
    export DOMAIN=${DOMAIN}
    export VERSION=${VERSION}
    
    log "Environment setup completed"
}

# Configure monitoring
setup_monitoring() {
    log "Setting up monitoring..."
    
    # Create monitoring directories
    mkdir -p monitoring/{rules,dashboards,alertmanager}
    
    # Generate monitoring configurations
    cat > monitoring/alertmanager.yml << EOF
global:
  smtp_smarthost: 'localhost:587'
  smtp_from: 'alerts@${DOMAIN}'

route:
  group_by: ['alertname']
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 1h
  receiver: 'web.hook'

receivers:
- name: 'web.hook'
  email_configs:
  - to: 'admin@${DOMAIN}'
    subject: 'Otedama Alert: {{ .GroupLabels.alertname }}'
    body: |
      {{ range .Alerts }}
      Alert: {{ .Annotations.summary }}
      Description: {{ .Annotations.description }}
      {{ end }}
EOF
    
    # Create Grafana dashboard provisioning
    mkdir -p monitoring/grafana/{dashboards,provisioning/{dashboards,datasources}}
    
    cat > monitoring/grafana/provisioning/datasources/prometheus.yml << EOF
apiVersion: 1

datasources:
- name: Prometheus
  type: prometheus
  url: http://prometheus:9090
  access: proxy
  isDefault: true
EOF
    
    cat > monitoring/grafana/provisioning/dashboards/dashboard.yml << EOF
apiVersion: 1

providers:
- name: 'default'
  orgId: 1
  folder: ''
  folderUid: ''
  type: file
  disableDeletion: false
  updateIntervalSeconds: 10
  allowUiUpdates: true
  options:
    path: /var/lib/grafana/dashboards
EOF
    
    log "Monitoring setup completed"
}

# Database setup
setup_database() {
    log "Setting up database..."
    
    # Create database directory
    mkdir -p data/db
    
    # Initialize database if not exists
    if [ ! -f "data/db/otedama.db" ]; then
        log "Initializing database..."
        node scripts/init-database.js
    fi
    
    # Run migrations
    log "Running database migrations..."
    node scripts/migrate.js
    
    log "Database setup completed"
}

# Security hardening
security_hardening() {
    log "Applying security hardening..."
    
    # Generate strong secrets
    JWT_SECRET=$(openssl rand -hex 32)
    CSRF_SECRET=$(openssl rand -hex 32)
    
    # Create secrets file
    cat > config/secrets.env << EOF
JWT_SECRET=${JWT_SECRET}
CSRF_SECRET=${CSRF_SECRET}
DATABASE_ENCRYPTION_KEY=$(openssl rand -hex 32)
REDIS_PASSWORD=$(openssl rand -hex 16)
EOF
    
    # Set secure permissions
    chmod 600 config/secrets.env
    
    # Configure firewall rules
    if command -v ufw >/dev/null 2>&1; then
        log "Configuring firewall..."
        ufw allow 80/tcp
        ufw allow 443/tcp
        ufw allow 3333/tcp
        ufw allow 8080/tcp
        ufw allow 8333/tcp
        ufw --force enable
    fi
    
    log "Security hardening completed"
}

# Docker deployment
deploy_docker() {
    log "Deploying with Docker..."
    
    # Build production image
    docker build -f Dockerfile.production -t otedama/otedama:${VERSION} .
    
    # Deploy with docker-compose
    docker-compose -f docker-compose.production.yml up -d
    
    # Wait for services to be ready
    log "Waiting for services to start..."
    sleep 30
    
    # Health check
    if curl -f http://localhost:8080/health; then
        log "Docker deployment successful"
    else
        error "Docker deployment failed - health check failed"
    fi
}

# Kubernetes deployment
deploy_kubernetes() {
    log "Deploying with Kubernetes..."
    
    # Apply namespace
    kubectl apply -f deploy/kubernetes/namespace.yaml
    
    # Apply secrets
    kubectl create secret generic otedama-secrets \
        --from-file=config/secrets.env \
        --namespace=otedama \
        --dry-run=client -o yaml | kubectl apply -f -
    
    # Apply SSL certificates
    kubectl create secret tls otedama-ssl \
        --cert=ssl/cert.pem \
        --key=ssl/key.pem \
        --namespace=otedama \
        --dry-run=client -o yaml | kubectl apply -f -
    
    # Deploy application
    kubectl apply -f deploy/kubernetes/deployment.yaml
    
    # Wait for deployment
    kubectl rollout status deployment/otedama-pool -n otedama
    
    # Get load balancer IP
    EXTERNAL_IP=$(kubectl get svc otedama-pool-service -n otedama -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
    
    log "Kubernetes deployment successful"
    log "External IP: ${EXTERNAL_IP}"
}

# Bare metal deployment
deploy_bare_metal() {
    log "Deploying on bare metal..."
    
    # Install dependencies
    npm ci --production
    
    # Build application
    npm run build
    
    # Create systemd service
    cat > /etc/systemd/system/otedama.service << EOF
[Unit]
Description=Otedama Mining Pool
After=network.target

[Service]
Type=simple
User=otedama
WorkingDirectory=/opt/otedama
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/opt/otedama/config/secrets.env

[Install]
WantedBy=multi-user.target
EOF
    
    # Create otedama user
    useradd -r -s /bin/false otedama
    chown -R otedama:otedama /opt/otedama
    
    # Start service
    systemctl daemon-reload
    systemctl enable otedama
    systemctl start otedama
    
    log "Bare metal deployment successful"
}

# Post-deployment setup
post_deployment() {
    log "Running post-deployment setup..."
    
    # Configure nginx reverse proxy
    if command -v nginx >/dev/null 2>&1; then
        log "Configuring nginx..."
        
        cat > /etc/nginx/sites-available/otedama << EOF
server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${DOMAIN};
    
    ssl_certificate /opt/otedama/ssl/cert.pem;
    ssl_certificate_key /opt/otedama/ssl/key.pem;
    
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    
    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    
    location /stratum {
        proxy_pass http://localhost:3333;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}
EOF
        
        ln -sf /etc/nginx/sites-available/otedama /etc/nginx/sites-enabled/
        nginx -t && systemctl reload nginx
    fi
    
    # Setup log rotation
    cat > /etc/logrotate.d/otedama << EOF
/opt/otedama/logs/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 644 otedama otedama
    postrotate
        systemctl reload otedama
    endscript
}
EOF
    
    # Setup backup cron job
    cat > /etc/cron.d/otedama-backup << EOF
0 2 * * * otedama /opt/otedama/scripts/backup.sh
EOF
    
    log "Post-deployment setup completed"
}

# Health check
health_check() {
    log "Performing health check..."
    
    # Check main application
    if curl -f http://localhost:8080/health; then
        log "Main application: OK"
    else
        error "Main application: FAILED"
    fi
    
    # Check API endpoints
    if curl -f http://localhost:8080/api/stats; then
        log "API endpoints: OK"
    else
        warn "API endpoints: WARNING"
    fi
    
    # Check stratum port
    if nc -z localhost 3333; then
        log "Stratum port: OK"
    else
        warn "Stratum port: WARNING"
    fi
    
    # Check P2P port
    if nc -z localhost 8333; then
        log "P2P port: OK"
    else
        warn "P2P port: WARNING"
    fi
    
    log "Health check completed"
}

# Performance optimization
optimize_performance() {
    log "Applying performance optimizations..."
    
    # System tuning
    if [ -f "/etc/sysctl.conf" ]; then
        cat >> /etc/sysctl.conf << EOF
# Otedama performance optimizations
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 5000
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_intvl = 60
net.ipv4.tcp_keepalive_probes = 10
fs.file-max = 1048576
EOF
        sysctl -p
    fi
    
    # Node.js optimizations
    export NODE_OPTIONS="--max-old-space-size=4096 --optimize-for-size"
    
    log "Performance optimization completed"
}

# Monitoring setup
setup_monitoring_stack() {
    log "Setting up monitoring stack..."
    
    case $DEPLOYMENT_TYPE in
        docker)
            docker-compose -f docker-compose.monitoring.yml up -d
            ;;
        kubernetes)
            kubectl apply -f deploy/kubernetes/monitoring.yaml
            ;;
        bare-metal)
            # Install and configure Prometheus
            wget https://github.com/prometheus/prometheus/releases/download/v2.40.0/prometheus-2.40.0.linux-amd64.tar.gz
            tar xzf prometheus-2.40.0.linux-amd64.tar.gz
            mv prometheus-2.40.0.linux-amd64 /opt/prometheus
            chown -R otedama:otedama /opt/prometheus
            ;;
    esac
    
    log "Monitoring stack setup completed"
}

# Main deployment function
main() {
    log "Starting Otedama production deployment..."
    log "Deployment type: ${DEPLOYMENT_TYPE}"
    log "Environment: ${ENVIRONMENT}"
    log "Version: ${VERSION}"
    log "Domain: ${DOMAIN}"
    
    check_prerequisites
    setup_environment
    setup_monitoring
    setup_database
    security_hardening
    optimize_performance
    
    case $DEPLOYMENT_TYPE in
        docker)
            deploy_docker
            ;;
        kubernetes)
            deploy_kubernetes
            ;;
        bare-metal)
            deploy_bare_metal
            ;;
        *)
            error "Unknown deployment type: ${DEPLOYMENT_TYPE}"
            ;;
    esac
    
    post_deployment
    setup_monitoring_stack
    health_check
    
    log "Deployment completed successfully!"
    log "Access your Otedama pool at: https://${DOMAIN}"
    log "Monitoring dashboard: https://${DOMAIN}:3000"
    log "Stratum endpoint: stratum+tcp://${DOMAIN}:3333"
    
    # Display important information
    echo -e "\n${BLUE}=== IMPORTANT INFORMATION ===${NC}"
    echo -e "${YELLOW}1. Update DNS records to point ${DOMAIN} to your server IP${NC}"
    echo -e "${YELLOW}2. Configure SSL certificates for production use${NC}"
    echo -e "${YELLOW}3. Update config/secrets.env with your actual secrets${NC}"
    echo -e "${YELLOW}4. Setup monitoring alerts and notifications${NC}"
    echo -e "${YELLOW}5. Configure backup destinations in config/production.json${NC}"
    echo -e "${BLUE}=================================${NC}\n"
}

# Run main function
main "$@"