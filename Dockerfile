# Otedama P2P Mining Pool v2.1.9
# Multi-stage build for minimal production image

# Build stage
FROM golang:1.21-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git gcc musl-dev

# Set working directory
WORKDIR /build

# Copy go mod files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Build the binary
RUN CGO_ENABLED=1 GOOS=linux go build \
    -ldflags="-s -w -X 'main.Version=Otedama-Docker' -X 'main.BuildTime=$(date -u +%Y-%m-%d_%H:%M:%S)'" \
    -trimpath \
    -o otedama \
    cmd/otedama/*.go

# Runtime stage
FROM alpine:latest

# Install runtime dependencies
RUN apk --no-cache add ca-certificates tzdata

# Create non-root user
RUN addgroup -g 1000 otedama && \
    adduser -D -u 1000 -G otedama otedama

# Set working directory
WORKDIR /app

# Copy binary from builder
COPY --from=builder /build/otedama /app/otedama

# Copy configuration files
COPY config.yaml.example /app/config.yaml.example

# Create data directories
RUN mkdir -p /app/data /app/logs && \
    chown -R otedama:otedama /app

# Switch to non-root user
USER otedama

# Expose ports
# API port
EXPOSE 8080
# SSL API port
EXPOSE 8443
# Metrics port
EXPOSE 9090
# Health port
EXPOSE 8081
# P2P port
EXPOSE 18555

# Volume for data persistence
VOLUME ["/app/data", "/app/logs"]

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8081/health/live || exit 1

# Default command
ENTRYPOINT ["/app/otedama"]
CMD ["-config", "/app/config.yaml"]
