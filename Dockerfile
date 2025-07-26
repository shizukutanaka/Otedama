# Otedama Mining Pool - Optimized Production Dockerfile
# Multi-stage build with security hardening

# Build stage
FROM node:18-alpine AS builder

# Install only necessary build dependencies
RUN apk add --no-cache --virtual .build-deps \
    python3 make g++ git && \
    apk add --no-cache --virtual .runtime-deps \
    libstdc++

WORKDIR /build

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies with exact versions
RUN npm ci --production --no-audit --no-fund && \
    npm cache clean --force

# Copy source code
COPY --chown=node:node . .

# Remove development files
RUN rm -rf test/ tests/ examples/ docs/ scripts/test* *.md .git* .env.example

# Production stage
FROM node:18-alpine AS production

# Install runtime dependencies only
RUN apk add --no-cache \
    tini \
    libstdc++ \
    && rm -rf /var/cache/apk/*

# Security: Create non-root user with specific UID/GID
RUN addgroup -g 10001 -S otedama && \
    adduser -S -u 10001 -G otedama -h /app -s /bin/false otedama

WORKDIR /app

# Copy built application
COPY --from=builder --chown=otedama:otedama /build/node_modules ./node_modules
COPY --from=builder --chown=otedama:otedama /build/lib ./lib
COPY --from=builder --chown=otedama:otedama /build/config ./config
COPY --from=builder --chown=otedama:otedama /build/scripts ./scripts
COPY --from=builder --chown=otedama:otedama /build/*.js ./
COPY --from=builder --chown=otedama:otedama /build/package*.json ./

# Create required directories with proper permissions
RUN mkdir -p data logs ssl backups && \
    chown -R otedama:otedama data logs ssl backups && \
    chmod 700 data backups && \
    chmod 755 logs

# Security hardening
RUN chmod -R o-rwx /app && \
    find /app -type d -exec chmod 750 {} \; && \
    find /app -type f -exec chmod 640 {} \;

# Drop all capabilities
USER otedama

# Expose only necessary ports
EXPOSE 3333 8080

# Environment variables
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=4096 --expose-gc" \
    LOG_LEVEL=info

# Health check with timeout
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node scripts/health-check.js || exit 1

# Use tini for proper PID 1 handling
ENTRYPOINT ["/sbin/tini", "--"]

# Start with memory optimization flags
CMD ["node", "index.js", "--mode", "pool"]