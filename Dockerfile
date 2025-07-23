# Multi-stage build for Otedama mining pool
FROM node:18-alpine AS builder

# Install build dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Copy source code
COPY . .

# Build native modules if needed
RUN if [ -d "native" ]; then \
        cd native && \
        npm install && \
        node-gyp rebuild; \
    fi

# Production image
FROM node:18-alpine

# Install runtime dependencies
RUN apk add --no-cache \
    ca-certificates \
    tzdata \
    tini && \
    addgroup -g 1000 otedama && \
    adduser -u 1000 -G otedama -s /bin/sh -D otedama

# Set working directory
WORKDIR /app

# Copy from builder
COPY --from=builder --chown=otedama:otedama /app/node_modules ./node_modules
COPY --from=builder --chown=otedama:otedama /app/native/build ./native/build
COPY --chown=otedama:otedama . .

# Create necessary directories
RUN mkdir -p /app/data /app/logs /app/config && \
    chown -R otedama:otedama /app

# Switch to non-root user
USER otedama

# Expose ports
EXPOSE 3333 8080 8081 6633 9090

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node scripts/health-check.js || exit 1

# Set environment variables
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=4096"

# Use tini for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Start the application
CMD ["node", "index.js", "--mode", "pool"]