# Otedama Dockerfile for development and standard deployment
# Optimized for quick builds and debugging

FROM golang:1.21-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git gcc musl-dev make

WORKDIR /build

# Copy go mod files for better caching
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build the binary
RUN go build -o otedama cmd/otedama/main.go

# Runtime stage
FROM alpine:3.19

# Install runtime dependencies
RUN apk add --no-cache ca-certificates curl

# Create app directory
WORKDIR /app

# Copy binary from builder
COPY --from=builder /build/otedama /app/

# Copy config if exists
COPY --from=builder /build/config.yaml* /app/

# Expose ports
EXPOSE 3333 8080 9090

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:8080/api/health || exit 1

# Volume for persistent data
VOLUME ["/app/data"]

# Run the binary
CMD ["./otedama", "start"]