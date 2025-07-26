#!/bin/bash
#
# Otedama Production Setup Script
# Automated deployment for production environments
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
OTEDAMA_USER="otedama"
OTEDAMA_HOME="/home/otedama"
OTEDAMA_DIR="$OTEDAMA_HOME/otedama"
NODE_VERSION="18"

# Functions
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

check_root() {
    if [[ $EUID -ne 0 ]]; then
        print_error "This script must be run as root"
        exit 1
    fi
}

# Check if running as root
check_root

print_status "Starting Otedama production setup..."

# Update system
print_status "Updating system packages..."
apt-get update && apt-get upgrade -y

# Install dependencies
print_status "Installing system dependencies..."
apt-get install -y \
    build-essential \
    git \
    curl \
    wget \
    nginx \
    redis-server \
    postgresql \
    postgresql-contrib \
    ufw \
    certbot \
    python3-certbot-nginx \
    htop \
    iotop \
    fail2ban

# Install Node.js
print_status "Installing Node.js $NODE_VERSION..."
curl -fsSL https://deb.nodesource.com/setup_$NODE_VERSION.x | bash -
apt-get install -y nodejs

# Install global npm packages
print_status "Installing PM2..."
npm install -g pm2

# Create otedama user
print_status "Creating otedama user..."
if ! id "$OTEDAMA_USER" &>/dev/null; then
    useradd -m -s /bin/bash $OTEDAMA_USER
    usermod -aG sudo $OTEDAMA_USER
else
    print_warning "User $OTEDAMA_USER already exists"
fi

# Setup PostgreSQL
print_status "Setting up PostgreSQL..."
sudo -u postgres psql <<EOF
CREATE DATABASE otedama;
CREATE USER otedama WITH ENCRYPTED PASSWORD 'changeme';
GRANT ALL PRIVILEGES ON DATABASE otedama TO otedama;
EOF

# Configure firewall
print_status "Configuring firewall..."
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS
ufw allow 3333/tcp  # Stratum
ufw allow 8080/tcp  # API
ufw allow 8081/tcp  # Dashboard
ufw --force enable

# Configure fail2ban
print_status "Configuring fail2ban..."
cat > /etc/fail2ban/jail.local <<EOF
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true
port = 22
filter = sshd
logpath = /var/log/auth.log
maxretry = 3

[nginx-http-auth]
enabled = true
filter = nginx-http-auth
port = http,https
logpath = /var/log/nginx/error.log

[nginx-noscript]
enabled = true
port = http,https
filter = nginx-noscript
logpath = /var/log/nginx/access.log
maxretry = 6

[nginx-badbots]
enabled = true
port = http,https
filter = nginx-badbots
logpath = /var/log/nginx/access.log
maxretry = 2

[nginx-noproxy]
enabled = true
port = http,https
filter = nginx-noproxy
logpath = /var/log/nginx/access.log
maxretry = 2
EOF

systemctl restart fail2ban

# Setup system limits
print_status "Configuring system limits..."
cat >> /etc/security/limits.conf <<EOF
$OTEDAMA_USER soft nofile 65536
$OTEDAMA_USER hard nofile 65536
$OTEDAMA_USER soft nproc 32768
$OTEDAMA_USER hard nproc 32768
EOF

# Setup sysctl parameters
print_status "Optimizing kernel parameters..."
cat >> /etc/sysctl.conf <<EOF
# Otedama optimizations
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 30
fs.file-max = 1000000
vm.swappiness = 10
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5
EOF

sysctl -p

# Clone repository
print_status "Cloning Otedama repository..."
sudo -u $OTEDAMA_USER bash <<EOF
cd $OTEDAMA_HOME
if [ ! -d "otedama" ]; then
    git clone https://github.com/yourusername/otedama.git
fi
cd otedama
npm install --production
EOF

# Create configuration
print_status "Creating configuration..."
sudo -u $OTEDAMA_USER bash <<EOF
cd $OTEDAMA_DIR
cp config/production.json config/local-production.json
cat > .env <<EOL
NODE_ENV=production
POOL_NAME=Otedama Pool
POOL_ADDRESS=YOUR_WALLET_ADDRESS
JWT_SECRET=$(openssl rand -base64 32)
CSRF_SECRET=$(openssl rand -base64 32)
BACKUP_ENCRYPTION_KEY=$(openssl rand -base64 32)
DATABASE_PASSWORD=changeme
EOL
chmod 600 .env
EOF

# Setup PM2
print_status "Setting up PM2..."
sudo -u $OTEDAMA_USER bash <<EOF
cd $OTEDAMA_DIR
pm2 start ecosystem.config.js
pm2 save
EOF

pm2 startup systemd -u $OTEDAMA_USER --hp $OTEDAMA_HOME

# Setup nginx
print_status "Configuring nginx..."
cat > /etc/nginx/sites-available/otedama <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name _;
    
    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2 default_server;
    listen [::]:443 ssl http2 default_server;
    server_name _;
    
    # SSL will be configured by certbot
    
    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
    add_header Content-Security-Policy "default-src 'self' http: https: data: blob: 'unsafe-inline'" always;
    
    # API
    location /api {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        
        # Rate limiting
        limit_req zone=api burst=20 nodelay;
    }
    
    # Dashboard
    location / {
        proxy_pass http://localhost:8081;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }
    
    # Monitoring endpoint
    location /health {
        access_log off;
        return 200 "healthy\\n";
        add_header Content-Type text/plain;
    }
}

# Rate limiting
limit_req_zone \$binary_remote_addr zone=api:10m rate=10r/s;
limit_req_zone \$binary_remote_addr zone=general:10m rate=30r/s;
EOF

# Enable site
ln -sf /etc/nginx/sites-available/otedama /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# Create systemd service for otedama
print_status "Creating systemd service..."
cat > /etc/systemd/system/otedama.service <<EOF
[Unit]
Description=Otedama Mining Pool
After=network.target

[Service]
Type=forking
User=$OTEDAMA_USER
WorkingDirectory=$OTEDAMA_DIR
ExecStart=/usr/bin/pm2 start ecosystem.config.js
ExecReload=/usr/bin/pm2 reload ecosystem.config.js
ExecStop=/usr/bin/pm2 stop ecosystem.config.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable otedama

# Setup log rotation
print_status "Configuring log rotation..."
cat > /etc/logrotate.d/otedama <<EOF
$OTEDAMA_DIR/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0640 $OTEDAMA_USER $OTEDAMA_USER
    sharedscripts
    postrotate
        /usr/bin/pm2 reloadLogs
    endscript
}
EOF

# Create backup script
print_status "Creating backup script..."
cat > $OTEDAMA_HOME/backup.sh <<EOF
#!/bin/bash
BACKUP_DIR="$OTEDAMA_HOME/backups"
DATE=\$(date +%Y%m%d_%H%M%S)
mkdir -p \$BACKUP_DIR

# Backup database
pg_dump -U otedama otedama | gzip > \$BACKUP_DIR/otedama_db_\$DATE.sql.gz

# Backup configuration
tar -czf \$BACKUP_DIR/otedama_config_\$DATE.tar.gz -C $OTEDAMA_DIR config .env

# Keep only last 7 days of backups
find \$BACKUP_DIR -name "*.gz" -mtime +7 -delete
EOF

chmod +x $OTEDAMA_HOME/backup.sh
chown $OTEDAMA_USER:$OTEDAMA_USER $OTEDAMA_HOME/backup.sh

# Add to crontab
(crontab -u $OTEDAMA_USER -l 2>/dev/null; echo "0 2 * * * $OTEDAMA_HOME/backup.sh") | crontab -u $OTEDAMA_USER -

# Final setup
print_status "Finalizing setup..."

# Create directories
sudo -u $OTEDAMA_USER mkdir -p $OTEDAMA_DIR/{logs,data,backups}

# Set permissions
chown -R $OTEDAMA_USER:$OTEDAMA_USER $OTEDAMA_HOME

print_status "Setup complete!"
print_warning "IMPORTANT: Please update the following:"
print_warning "1. Change PostgreSQL password in /etc/postgresql/*/main/postgresql.conf"
print_warning "2. Update POOL_ADDRESS in $OTEDAMA_DIR/.env"
print_warning "3. Configure SSL certificate with: certbot --nginx -d your-domain.com"
print_warning "4. Update config/local-production.json with your settings"
print_warning "5. Restart services: systemctl restart otedama nginx"

print_status "Access your pool:"
print_status "  Stratum: stratum+tcp://your-server:3333"
print_status "  API: https://your-server/api"
print_status "  Dashboard: https://your-server/"

print_status "Monitor with: pm2 monit"