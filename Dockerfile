# Otedama Mining Pool - Production Dockerfile
# Multi-stage build for optimal size and security

# Build stage
FROM node:18-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++ git

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Production stage
FROM node:18-alpine

# Install runtime dependencies
RUN apk add --no-cache tini

# Create non-root user
RUN addgroup -g 1001 -S otedama && \
    adduser -S -u 1001 -G otedama otedama

# Set working directory
WORKDIR /app

# Copy from builder
COPY --from=builder --chown=otedama:otedama /app/node_modules ./node_modules
COPY --chown=otedama:otedama . .

# Create required directories
RUN mkdir -p data logs && \
    chown -R otedama:otedama data logs

# Switch to non-root user
USER otedama

# Expose ports
EXPOSE 3333 3336 8080 9090 33333

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node scripts/health-check.js || exit 1

# Use tini as entrypoint for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Start the pool
CMD ["node", "--expose-gc", "start-mining-pool.js"]
