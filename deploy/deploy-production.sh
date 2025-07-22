#!/bin/bash
# Otedama Production Deployment Script
# Comprehensive deployment with security, SSL/TLS, and monitoring

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
ENVIRONMENT="${ENVIRONMENT:-production}"
ENABLE_SSL="${ENABLE_SSL:-true}"
ENABLE_MONITORING="${ENABLE_MONITORING:-true}"
ENABLE_BACKUP="${ENABLE_BACKUP:-true}"

# Functions
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
    exit 1
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

check_requirements() {
    log "Checking requirements..."
    
    # Check Docker
    if ! command -v docker &> /dev/null; then
        error "Docker is not installed. Please install Docker first."
    fi
    
    # Check Docker Compose
    if ! command -v docker-compose &> /dev/null; then
        error "Docker Compose is not installed. Please install Docker Compose first."
    fi
    
    # Check Git
    if ! command -v git &> /dev/null; then
        error "Git is not installed. Please install Git first."
    fi
    
    log "All requirements satisfied."
}

setup_environment() {
    log "Setting up environment..."
    
    # Check if .env exists
    if [ ! -f .env ]; then
        log "Creating .env file from template..."
        cp .env.example .env
        
        # Generate secure secrets
        JWT_SECRET=$(openssl rand -hex 32)
        CSRF_SECRET=$(openssl rand -hex 32)
        SESSION_SECRET=$(openssl rand -hex 32)
        COOKIE_SECRET=$(openssl rand -hex 32)
        DB_PASSWORD=$(openssl rand -hex 16)
        REDIS_PASSWORD=$(openssl rand -hex 16)
        GRAFANA_PASSWORD=$(openssl rand -hex 16)
        
        # Update .env with generated secrets
        sed -i "s/JWT_SECRET=.*/JWT_SECRET=$JWT_SECRET/" .env
        sed -i "s/CSRF_SECRET=.*/CSRF_SECRET=$CSRF_SECRET/" .env
        sed -i "s/SESSION_SECRET=.*/SESSION_SECRET=$SESSION_SECRET/" .env
        sed -i "s/COOKIE_SECRET=.*/COOKIE_SECRET=$COOKIE_SECRET/" .env
        
        # Add database passwords
        echo "DB_PASSWORD=$DB_PASSWORD" >> .env
        echo "REDIS_PASSWORD=$REDIS_PASSWORD" >> .env
        echo "GRAFANA_PASSWORD=$GRAFANA_PASSWORD" >> .env
        
        log "Generated secure secrets in .env file"
        warning "Please review and update .env file with your specific configuration"
    else
        log ".env file already exists"
    fi
    
    # Set production environment
    sed -i "s/NODE_ENV=.*/NODE_ENV=production/" .env
}

setup_ssl() {
    if [ "$ENABLE_SSL" != "true" ]; then
        log "SSL setup skipped"
        return
    fi
    
    if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
        warning "DOMAIN and EMAIL required for SSL setup. Skipping SSL configuration."
        return
    fi
    
    log "Setting up SSL for domain: $DOMAIN"
    
    # Create nginx configuration
    cat > deploy/nginx.conf << EOF
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
    worker_connections 1024;
    use epoll;
    multi_accept on;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # Logging
    access_log /var/log/nginx/access.log combined;

    # Performance
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;
    client_max_body_size 20M;

    # Gzip
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml text/javascript application/json application/javascript application/xml+rss application/rss+xml application/atom+xml image/svg+xml;

    # Rate limiting
    limit_req_zone \$binary_remote_addr zone=api:10m rate=10r/s;
    limit_req_zone \$binary_remote_addr zone=auth:10m rate=5r/m;

    # Upstream servers
    upstream otedama_api {
        server otedama:8080;
        keepalive 32;
    }

    upstream otedama_ws {
        server otedama:8081;
    }

    upstream otedama_dex_ws {
        server otedama:8082;
    }

    # HTTP redirect
    server {
        listen 80;
        listen [::]:80;
        server_name $DOMAIN www.$DOMAIN;
        return 301 https://\$server_name\$request_uri;
    }

    # HTTPS server
    server {
        listen 443 ssl http2;
        listen [::]:443 ssl http2;
        server_name $DOMAIN www.$DOMAIN;

        # SSL configuration
        ssl_certificate /etc/nginx/ssl/fullchain.pem;
        ssl_certificate_key /etc/nginx/ssl/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers HIGH:!aNULL:!MD5;
        ssl_prefer_server_ciphers on;
        ssl_session_cache shared:SSL:10m;
        ssl_session_timeout 10m;

        # API endpoints
        location /api {
            limit_req zone=api burst=20 nodelay;
            
            proxy_pass http://otedama_api;
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;
            
            # Timeouts
            proxy_connect_timeout 60s;
            proxy_send_timeout 60s;
            proxy_read_timeout 60s;
        }

        # WebSocket endpoints
        location /ws {
            proxy_pass http://otedama_ws;
            proxy_http_version 1.1;
            proxy_set_header Upgrade \$http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;
            
            # WebSocket timeout
            proxy_read_timeout 3600s;
            proxy_send_timeout 3600s;
        }

        # DEX WebSocket
        location /dex-ws {
            proxy_pass http://otedama_dex_ws;
            proxy_http_version 1.1;
            proxy_set_header Upgrade \$http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;
        }

        # Auth endpoints with stricter rate limiting
        location ~ ^/api/(login|register|2fa) {
            limit_req zone=auth burst=5 nodelay;
            
            proxy_pass http://otedama_api;
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;
        }

        # Health check endpoint
        location /health {
            access_log off;
            proxy_pass http://otedama_api/health;
        }

        # Metrics endpoint (restricted)
        location /metrics {
            allow 10.0.0.0/8;
            allow 172.16.0.0/12;
            allow 192.168.0.0/16;
            deny all;
            
            proxy_pass http://otedama:9090/metrics;
        }
    }
}
EOF

    # Update docker-compose to use SSL profile
    export COMPOSE_PROFILES="ssl,production"
    
    log "SSL configuration created"
}

setup_monitoring() {
    if [ "$ENABLE_MONITORING" != "true" ]; then
        log "Monitoring setup skipped"
        return
    fi
    
    log "Setting up monitoring..."
    
    # Create Prometheus configuration
    mkdir -p deploy/monitoring
    cat > deploy/monitoring/prometheus.yml << EOF
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'otedama'
    static_configs:
      - targets: ['otedama:9090']
    metrics_path: '/metrics'

  - job_name: 'node-exporter'
    static_configs:
      - targets: ['node-exporter:9100']

  - job_name: 'redis'
    static_configs:
      - targets: ['redis-exporter:9121']

  - job_name: 'postgres'
    static_configs:
      - targets: ['postgres-exporter:9187']
EOF

    # Create Grafana provisioning
    mkdir -p deploy/monitoring/grafana/provisioning/{datasources,dashboards}
    
    cat > deploy/monitoring/grafana/provisioning/datasources/prometheus.yml << EOF
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
EOF

    log "Monitoring configuration created"
}

deploy_application() {
    log "Deploying Otedama..."
    
    # Build Docker images
    log "Building Docker images..."
    docker-compose build --no-cache
    
    # Start services
    log "Starting services..."
    
    PROFILES=""
    [ "$ENABLE_SSL" = "true" ] && PROFILES="$PROFILES,ssl"
    [ "$ENABLE_MONITORING" = "true" ] && PROFILES="$PROFILES,monitoring"
    [ "$ENABLE_BACKUP" = "true" ] && PROFILES="$PROFILES,backup"
    
    export COMPOSE_PROFILES="${PROFILES#,}"
    
    docker-compose up -d
    
    # Wait for services to be healthy
    log "Waiting for services to be healthy..."
    sleep 10
    
    # Check service health
    docker-compose ps
}

setup_ssl_certificates() {
    if [ "$ENABLE_SSL" != "true" ] || [ -z "$DOMAIN" ]; then
        return
    fi
    
    log "Setting up SSL certificates..."
    
    # Check if certificates already exist
    if [ -f "deploy/ssl/fullchain.pem" ] && [ -f "deploy/ssl/privkey.pem" ]; then
        log "SSL certificates already exist"
        return
    fi
    
    # Create SSL directory
    mkdir -p deploy/ssl
    
    # Use certbot to get certificates
    docker run -it --rm \
        -v "$(pwd)/deploy/ssl:/etc/letsencrypt" \
        -v "$(pwd)/deploy/certbot:/var/www/certbot" \
        -p 80:80 \
        certbot/certbot certonly \
        --standalone \
        --email "$EMAIL" \
        --agree-tos \
        --no-eff-email \
        --domains "$DOMAIN,www.$DOMAIN"
    
    # Copy certificates to the right location
    cp deploy/ssl/live/$DOMAIN/fullchain.pem deploy/ssl/
    cp deploy/ssl/live/$DOMAIN/privkey.pem deploy/ssl/
    
    log "SSL certificates obtained successfully"
}

post_deployment() {
    log "Running post-deployment tasks..."
    
    # Run database migrations
    log "Running database migrations..."
    docker-compose exec -T otedama node scripts/migrate.js
    
    # Create initial admin user (if needed)
    if [ ! -f ".admin_created" ]; then
        log "Creating admin user..."
        ADMIN_PASSWORD=$(openssl rand -hex 16)
        
        docker-compose exec -T otedama node -e "
        const bcrypt = require('bcrypt');
        const { DatabaseManager } = require('./lib/database');
        
        (async () => {
            const db = new DatabaseManager();
            await db.initialize();
            
            const hashedPassword = await bcrypt.hash('$ADMIN_PASSWORD', 10);
            
            await db.query(
                'INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)',
                ['admin', '$EMAIL', hashedPassword, 'admin']
            );
            
            console.log('Admin user created');
            process.exit(0);
        })();
        "
        
        echo "Admin credentials:" > admin_credentials.txt
        echo "Username: admin" >> admin_credentials.txt
        echo "Password: $ADMIN_PASSWORD" >> admin_credentials.txt
        chmod 600 admin_credentials.txt
        
        touch .admin_created
        
        log "Admin user created. Credentials saved to admin_credentials.txt"
        warning "Please change the admin password after first login!"
    fi
    
    # Setup cron jobs for backup
    if [ "$ENABLE_BACKUP" = "true" ]; then
        log "Setting up backup cron job..."
        
        # Create backup script
        cat > deploy/backup.sh << 'EOF'
#!/bin/bash
docker-compose exec -T otedama node scripts/backup.js
EOF
        chmod +x deploy/backup.sh
        
        # Add to crontab
        (crontab -l 2>/dev/null; echo "0 2 * * * $(pwd)/deploy/backup.sh") | crontab -
        
        log "Backup cron job configured"
    fi
}

show_summary() {
    log "Deployment completed successfully!"
    
    echo
    echo "========================================="
    echo "Otedama Production Deployment Summary"
    echo "========================================="
    echo
    echo "Services deployed:"
    echo "  - API: http://localhost:8080"
    echo "  - WebSocket: ws://localhost:8081"
    echo "  - DEX WebSocket: ws://localhost:8082"
    echo "  - P2P: localhost:8333"
    
    if [ "$ENABLE_SSL" = "true" ] && [ -n "$DOMAIN" ]; then
        echo
        echo "SSL endpoints:"
        echo "  - API: https://$DOMAIN/api"
        echo "  - WebSocket: wss://$DOMAIN/ws"
        echo "  - DEX WebSocket: wss://$DOMAIN/dex-ws"
    fi
    
    if [ "$ENABLE_MONITORING" = "true" ]; then
        echo
        echo "Monitoring:"
        echo "  - Prometheus: http://localhost:9091"
        echo "  - Grafana: http://localhost:3000"
        echo "    Username: admin"
        echo "    Password: Check GRAFANA_PASSWORD in .env"
    fi
    
    echo
    echo "Important files:"
    echo "  - Configuration: .env"
    echo "  - Admin credentials: admin_credentials.txt"
    echo "  - Logs: docker-compose logs -f otedama"
    echo
    echo "Next steps:"
    echo "  1. Review and update .env file"
    echo "  2. Change admin password"
    echo "  3. Configure firewall rules"
    echo "  4. Setup monitoring alerts"
    echo "  5. Test all endpoints"
    echo
    echo "========================================="
}

# Main execution
main() {
    log "Starting Otedama production deployment..."
    
    check_requirements
    setup_environment
    setup_ssl_certificates
    setup_ssl
    setup_monitoring
    deploy_application
    post_deployment
    show_summary
}

# Run main function
main "$@"