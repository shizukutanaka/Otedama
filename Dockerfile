FROM node:18-alpine

# Labels for better container management
LABEL maintainer="Otedama Team <contact@otedama.com>"
LABEL description="Otedama Commercial Pro - Enterprise P2P Mining Pool + DeFi Platform"
LABEL version="6.0.0"
LABEL operator.btc.address="bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
LABEL operator.fee.rate="0.1%"
LABEL features="automated-payments,immutable-fees,enterprise-security,multi-chain"

# Install system dependencies
RUN apk add --no-cache \
    sqlite \
    dumb-init \
    curl \
    && rm -rf /var/cache/apk/*

# Create app user and directory
RUN addgroup -g 1001 -S otedama \
    && adduser -S -D -H -u 1001 -s /sbin/nologin -G otedama otedama

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production \
    && npm cache clean --force \
    && rm -rf /tmp/*

# Copy application code
COPY --chown=otedama:otedama . .

# Create required directories with proper permissions
RUN mkdir -p data logs \
    && chown -R otedama:otedama /app

# Switch to non-root user
USER otedama

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Expose ports
EXPOSE 3333 8080 8333 9090

# Set environment variables
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=2048"

# Use dumb-init to handle signals properly
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Start application
CMD ["node", "index.js"]
