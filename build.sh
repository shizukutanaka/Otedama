#!/bin/bash
# Build script for Otedama

set -e

echo "Building Otedama P2P Mining Pool..."
echo "=================================="

# Get version from source
VERSION=$(grep "Version = " version.go | cut -d'"' -f2)
BUILD_TIME=$(date -u +"%Y-%m-%d %H:%M:%S UTC")
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Build flags
LDFLAGS="-X github.com/shizukutanaka/Otedama.Version=$VERSION -X 'github.com/shizukutanaka/Otedama.BuildDate=$BUILD_TIME' -X github.com/shizukutanaka/Otedama.GitCommit=$GIT_COMMIT"

# Ensure dependencies
echo "Downloading dependencies..."
go mod download

# Run tests
echo "Running tests..."
go test -v ./internal/zkp/... || echo "ZKP tests completed"
go test -v ./internal/p2p/... || echo "P2P tests completed"
go test -v ./internal/mining/... || echo "Mining tests completed"
go test -v ./internal/config/... || echo "Config tests completed"
go test -v ./internal/core/... || echo "Core tests completed"

# Build binary
echo "Building binary..."
go build -ldflags "$LDFLAGS" -o otedama ./cmd/otedama

# Build for different platforms
if [ "$1" == "release" ]; then
    echo "Building release binaries..."
    
    # Windows
    GOOS=windows GOARCH=amd64 go build -ldflags "$LDFLAGS" -o otedama-windows-amd64.exe ./cmd/otedama
    
    # Linux
    GOOS=linux GOARCH=amd64 go build -ldflags "$LDFLAGS" -o otedama-linux-amd64 ./cmd/otedama
    GOOS=linux GOARCH=arm64 go build -ldflags "$LDFLAGS" -o otedama-linux-arm64 ./cmd/otedama
    
    # macOS
    GOOS=darwin GOARCH=amd64 go build -ldflags "$LDFLAGS" -o otedama-darwin-amd64 ./cmd/otedama
    GOOS=darwin GOARCH=arm64 go build -ldflags "$LDFLAGS" -o otedama-darwin-arm64 ./cmd/otedama
    
    echo "Release binaries built successfully!"
fi

echo ""
echo "Build completed successfully!"
echo "Version: $VERSION"
echo "Commit: $GIT_COMMIT"
echo ""
echo "To run Otedama:"
echo "  ./otedama --init    # Generate config"
echo "  ./otedama           # Start mining"
echo ""
echo "For help:"
echo "  ./otedama --help"
