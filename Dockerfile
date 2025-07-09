# Otedama Light - Production Docker Image
# Multi-stage build for optimized production deployment

# Build stage
FROM node:18-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++ git

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Copy source code
COPY src ./src
COPY config ./config

# Build TypeScript
RUN npm install -g typescript && \
    tsc

# Runtime stage
FROM node:18-alpine

# Install runtime dependencies
RUN apk add --no-cache \
    curl \
    ca-certificates \
    tzdata && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy built application
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./
COPY --chown=nodejs:nodejs config ./config

# Create necessary directories
RUN mkdir -p logs data backups && \
    chown -R nodejs:nodejs logs data backups

# Set user
USER nodejs

# Expose ports
EXPOSE 3333 3001 4333 9090

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3001/health || exit 1

# Environment variables
ENV NODE_ENV=production \
    LOG_LEVEL=info

# Start the application
CMD ["node", "dist/main-integrated.js"]
