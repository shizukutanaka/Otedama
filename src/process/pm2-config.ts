// PM2 configuration for production deployment
export const pm2Config = {
  apps: [{
    name: 'otedama-pool',
    script: './dist/main-enhanced.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '2G',
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/pm2-combined.log',
    time: true,
    env: {
      NODE_ENV: 'production',
      PORT: 3333
    },
    // Auto restart on crash
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    // Graceful shutdown
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,
    // Monitoring
    instance_var: 'INSTANCE_ID',
    merge_logs: true,
    // Performance
    node_args: '--max-old-space-size=2048'
  }]
};

// Ecosystem file generator
export function generateEcosystemFile(): string {
  return `module.exports = ${JSON.stringify(pm2Config, null, 2)};`;
}

// Systemd service file generator
export function generateSystemdService(user: string = 'pool'): string {
  return `[Unit]
Description=Otedama Mining Pool
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=/opt/otedama-pool
ExecStart=/usr/bin/node /opt/otedama-pool/dist/main-enhanced.js
Restart=always
RestartSec=10

# Resource limits
LimitNOFILE=65536
LimitNPROC=4096

# Environment
Environment="NODE_ENV=production"
Environment="NODE_OPTIONS=--max-old-space-size=2048"

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=otedama-pool

[Install]
WantedBy=multi-user.target`;
}

// Docker compose configuration
export function generateDockerCompose(): string {
  return `version: '3.8'

services:
  otedama-pool:
    build: .
    container_name: otedama-pool
    restart: unless-stopped
    ports:
      - "3333:3333"     # Stratum
      - "8080:8080"     # Dashboard
      - "8081:8081"     # WebSocket
      - "8088:8088"     # API
      - "9090:9090"     # Metrics
      - "3001:3001"     # Health check
    volumes:
      - ./data:/app/data
      - ./logs:/app/logs
      - ./backups:/app/backups
      - ./.env:/app/.env:ro
    environment:
      - NODE_ENV=production
      - NODE_OPTIONS=--max-old-space-size=2048
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
    logging:
      driver: "json-file"
      options:
        max-size: "100m"
        max-file: "5"
    networks:
      - pool-network

  redis:
    image: redis:7-alpine
    container_name: otedama-redis
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes
    networks:
      - pool-network

networks:
  pool-network:
    driver: bridge

volumes:
  redis-data:`;
}
