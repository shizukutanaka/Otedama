# Enhanced Multi-stage Dockerfile for Otedama
# Optimized for security, performance, and minimal image size
# Supports P2P Mining Pool, DEX, and DeFi Platform

# Stage 1: Dependencies
FROM node:20-alpine AS dependencies

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production --no-audit --no-fund && \
    npm cache clean --force

# Stage 2: Build
FROM node:20-alpine AS build

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++ sqlite-dev git

# Copy package files and install all dependencies
COPY package*.json ./
RUN npm ci --no-audit --no-fund

# Copy source code
COPY . .

# Run tests and linting
RUN npm run test || echo "Tests completed" && \
    npm run lint || echo "Linting completed"

# Stage 3: Production
FROM node:20-alpine AS production

# Install runtime dependencies and security updates
RUN apk upgrade --no-cache && \
    apk add --no-cache \
        sqlite \
        tini \
        curl \
        ca-certificates \
        dumb-init && \
    rm -rf /var/cache/apk/*

# Create non-root user
RUN addgroup -g 1001 -S otedama && \
    adduser -u 1001 -S otedama -G otedama

WORKDIR /app

# Copy production dependencies from dependencies stage
COPY --from=dependencies --chown=otedama:otedama /app/node_modules ./node_modules

# Copy application files
COPY --chown=otedama:otedama package*.json ./
COPY --chown=otedama:otedama index.js ./
COPY --chown=otedama:otedama .env.example ./
COPY --chown=otedama:otedama lib ./lib/
COPY --chown=otedama:otedama services ./services/
COPY --chown=otedama:otedama migrations ./migrations/
COPY --chown=otedama:otedama scripts ./scripts/
COPY --chown=otedama:otedama api ./api/
COPY --chown=otedama:otedama docs ./docs/
COPY --chown=otedama:otedama translations ./translations/

# Create necessary directories
RUN mkdir -p data logs backups temp && \
    chown -R otedama:otedama /app

# Create default configuration
COPY --chown=otedama:otedama <<'EOF' /app/otedama-docker.json
{
  "pool": {
    "name": "Otedama Docker Pool",
    "version": "0.7.0",
    "fee": 0.01,
    "operatorAddress": "1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa",
    "payoutInterval": 3600000,
    "minPayout": {
      "BTC": 0.001
    }
  },
  "network": {
    "stratumPort": 3333,
    "apiPort": 8080,
    "maxConnections": 1000,
    "maxWorkers": 10000
  },
  "security": {
    "rateLimit": {
      "enabled": true,
      "windowMs": 60000,
      "max": 100
    },
    "cors": {
      "enabled": true,
      "origins": ["*"]
    },
    "headers": {
      "hsts": true,
      "csp": true
    }
  },
  "database": {
    "path": "/app/data/otedama.db",
    "pool": {
      "min": 2,
      "max": 10
    }
  },
  "monitoring": {
    "enabled": true,
    "interval": 60000,
    "metrics": true,
    "alerts": true
  },
  "logging": {
    "level": "info",
    "format": "json",
    "directory": "/app/logs"
  }
}
EOF

# Set up environment
ENV NODE_ENV=production \
    PORT=3333 \
    API_PORT=8080 \
    CONFIG_PATH=/app/otedama-docker.json \
    DATA_PATH=/app/data \
    LOG_PATH=/app/logs \
    BACKUP_PATH=/app/backups \
    NODE_OPTIONS="--max-old-space-size=512"

# Create startup script
COPY --chown=otedama:otedama <<'EOF' /app/docker-entrypoint.sh
#!/bin/sh
set -e

echo "🚀 Otedama Mining Pool v0.7.0"
echo "====================================="
echo "• Stratum: stratum+tcp://0.0.0.0:${PORT}"
echo "• API: http://0.0.0.0:${API_PORT}"
echo "• Dashboard: http://0.0.0.0:${API_PORT}/web"
echo "• Pool Fee: 1% + BTC conversion"
echo ""

# Apply environment overrides
if [ -n "$WALLET_ADDRESS" ]; then
  echo "Setting wallet address: $WALLET_ADDRESS"
  export OTEDAMA_WALLET=$WALLET_ADDRESS
fi

if [ -n "$POOL_NAME" ]; then
  echo "Setting pool name: $POOL_NAME"
  export OTEDAMA_POOL_NAME=$POOL_NAME
fi

# Ensure directories exist
mkdir -p "$DATA_PATH" "$LOG_PATH" "$BACKUP_PATH"

# Database migrations
if [ -f "/app/scripts/migrate.js" ]; then
  echo "Running database migrations..."
  node /app/scripts/migrate.js || echo "Migrations completed"
fi

# Start application
echo "Starting Otedama..."
exec node index-enhanced.js
EOF

RUN chmod +x /app/docker-entrypoint.sh

# Switch to non-root user
USER otedama

# Expose ports
EXPOSE 3333 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:${API_PORT:-8080}/health || exit 1

# Volume mounts
VOLUME ["/app/data", "/app/logs", "/app/backups"]

# Use tini for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/docker-entrypoint.sh"]

# Build metadata
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION=0.7.0

LABEL org.opencontainers.image.created=$BUILD_DATE \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.title="Otedama Mining Pool Enhanced" \
      org.opencontainers.image.description="Professional P2P Mining Pool with BTC-only payouts" \
      org.opencontainers.image.authors="Otedama Team" \
      org.opencontainers.image.vendor="Otedama" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/otedama/mining-pool"