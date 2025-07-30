# Otedama v2.0.0 - Production Dockerfile
# Multi-stage build for Go application

# Build stage
FROM golang:1.21-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git make gcc musl-dev

WORKDIR /build

# Copy go mod files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Get version info
RUN VERSION=$(grep "Version = " version.go | cut -d'"' -f2) && \
    BUILD_TIME=$(date -u +"%Y-%m-%d %H:%M:%S UTC") && \
    GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Build the application
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo \
    -ldflags="-w -s -X github.com/shizukutanaka/Otedama.Version=$VERSION -X 'github.com/shizukutanaka/Otedama.BuildDate=$BUILD_TIME' -X github.com/shizukutanaka/Otedama.GitCommit=$GIT_COMMIT" \
    -o otedama ./cmd/otedama

# Production stage
FROM alpine:3.19

# Install runtime dependencies
RUN apk add --no-cache ca-certificates tzdata && \
    rm -rf /var/cache/apk/*

# Create non-root user
RUN addgroup -g 10001 -S otedama && \
    adduser -S -u 10001 -G otedama -h /app -s /bin/false otedama

WORKDIR /app

# Copy binary from builder
COPY --from=builder --chown=otedama:otedama /build/otedama ./bin/otedama

# Copy configuration files
COPY --chown=otedama:otedama config.yaml ./config.yaml.example

# Create required directories
RUN mkdir -p data logs && \
    chown -R otedama:otedama data logs && \
    chmod 700 data && \
    chmod 755 logs

# Drop privileges
USER otedama

# Expose ports
EXPOSE 8080 30303 3333 9090

# Environment variables
ENV LOG_LEVEL=info

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["/app/bin/otedama", "-health-check"]

# Run the application
ENTRYPOINT ["/app/bin/otedama"]
CMD ["-config", "/app/config.yaml"]