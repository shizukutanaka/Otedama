# Makefile for Otedama P2P Mining Pool v2.1.9
# Cross-platform build

# Variables
BINARY_NAME=otedama
BINARY_DIR=build/bin
SOURCE_DIR=cmd/otedama
VERSION=2.1.9
LDFLAGS=-ldflags "-s -w -X 'main.Version=$(VERSION)' -X 'main.BuildTime=$(shell date -u +%Y-%m-%d_%H:%M:%S)'"
GCFLAGS=-gcflags="-l=4"

# Go parameters
GOCMD=go
GOBUILD=$(GOCMD) build
GOCLEAN=$(GOCMD) clean
GOTEST=$(GOCMD) test
GOGET=$(GOCMD) get
GOMOD=$(GOCMD) mod
GOVET=$(GOCMD) vet
GOFMT=gofmt

# Detect OS
ifeq ($(OS),Windows_NT)
	BINARY_NAME := $(BINARY_NAME).exe
	RM = del /Q
	MKDIR = mkdir
else
	UNAME_S := $(shell uname -s)
	RM = rm -f
	MKDIR = mkdir -p
endif

# Targets
.PHONY: all build clean test coverage fmt vet lint security run help

all: clean fmt vet test build

# Build the application
build:
	@echo "Building Otedama..."
	@$(MKDIR) $(BINARY_DIR) 2>/dev/null || true
	@$(GOBUILD) -v $(LDFLAGS) $(GCFLAGS) -trimpath -o $(BINARY_DIR)/$(BINARY_NAME) $(SOURCE_DIR)/*.go
	@echo "Build complete: $(BINARY_DIR)/$(BINARY_NAME)"

# Build for multiple platforms
build-all: build-linux build-windows build-darwin

build-linux:
	@echo "Building for Linux..."
	@GOOS=linux GOARCH=amd64 $(GOBUILD) $(LDFLAGS) -o $(BINARY_DIR)/otedama-linux-amd64 $(SOURCE_DIR)/*.go
	@GOOS=linux GOARCH=arm64 $(GOBUILD) $(LDFLAGS) -o $(BINARY_DIR)/otedama-linux-arm64 $(SOURCE_DIR)/*.go

build-windows:
	@echo "Building for Windows..."
	@GOOS=windows GOARCH=amd64 $(GOBUILD) $(LDFLAGS) -o $(BINARY_DIR)/otedama-windows-amd64.exe $(SOURCE_DIR)/*.go

build-darwin:
	@echo "Building for macOS..."
	@GOOS=darwin GOARCH=amd64 $(GOBUILD) $(LDFLAGS) -o $(BINARY_DIR)/otedama-darwin-amd64 $(SOURCE_DIR)/*.go
	@GOOS=darwin GOARCH=arm64 $(GOBUILD) $(LDFLAGS) -o $(BINARY_DIR)/otedama-darwin-arm64 $(SOURCE_DIR)/*.go

# Clean build artifacts
clean:
	@echo "Cleaning..."
	@$(GOCLEAN)
	@$(RM) $(BINARY_DIR)/$(BINARY_NAME) 2>/dev/null || true
	@$(RM) $(BINARY_DIR)/otedama-* 2>/dev/null || true
	@echo "Clean complete"

# Run tests
test:
	@echo "Running tests..."
	@$(GOTEST) -v -race -short ./...

# Run tests with coverage
coverage:
	@echo "Running tests with coverage..."
	@$(GOTEST) -v -race -coverprofile=coverage.out ./...
	@$(GOCMD) tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report: coverage.html"

# Format code
fmt:
	@echo "Formatting code..."
	@$(GOFMT) -w -s .
	@echo "Format complete"

# Run go vet
vet:
	@echo "Running go vet..."
	@$(GOVET) ./...

# Run linter
lint:
	@echo "Running linter..."
	@golangci-lint run --deadline=10m

# Security scan
security:
	@echo "Running security scan..."
	@gosec -quiet ./...
	@nancy go.sum

# Run the application
run: build
	@echo "Starting Otedama..."
	@$(BINARY_DIR)/$(BINARY_NAME)

# Run in debug mode
debug: build
	@echo "Starting Otedama in debug mode..."
	@$(BINARY_DIR)/$(BINARY_NAME) -debug

# Run benchmark
benchmark: build
	@echo "Running benchmark..."
	@$(BINARY_DIR)/$(BINARY_NAME) -benchmark

# Update dependencies
deps:
	@echo "Updating dependencies..."
	@$(GOMOD) download
	@$(GOMOD) tidy
	@$(GOMOD) verify

# Install development tools
install-tools:
	@echo "Installing development tools..."
	@$(GOGET) -u github.com/golangci/golangci-lint/cmd/golangci-lint
	@$(GOGET) -u github.com/securego/gosec/v2/cmd/gosec
	@$(GOGET) -u github.com/sonatype-nexus-community/nancy

# Create distribution package
dist: build-all
	@echo "Creating distribution packages..."
	@$(MKDIR) dist 2>/dev/null || true
	@tar -czf dist/otedama-linux-amd64.tar.gz -C $(BINARY_DIR) otedama-linux-amd64
	@tar -czf dist/otedama-linux-arm64.tar.gz -C $(BINARY_DIR) otedama-linux-arm64
	@tar -czf dist/otedama-darwin-amd64.tar.gz -C $(BINARY_DIR) otedama-darwin-amd64
	@tar -czf dist/otedama-darwin-arm64.tar.gz -C $(BINARY_DIR) otedama-darwin-arm64
	@zip -j dist/otedama-windows-amd64.zip $(BINARY_DIR)/otedama-windows-amd64.exe
	@echo "Distribution packages created in dist/"

# Docker build
docker:
	@echo "Building Docker image..."
	@docker build -t otedama:latest .

# Docker run
docker-run:
	@echo "Running Docker container..."
	@docker run -d --name otedama -p 8080:8080 -p 18555:18555 otedama:latest

# Help
help:
	@echo "Otedama Makefile"
	@echo ""
	@echo "Usage:"
	@echo "  make              Build the application"
	@echo "  make build        Build the application"
	@echo "  make build-all    Build for all platforms"
	@echo "  make clean        Remove build artifacts"
	@echo "  make test         Run tests"
	@echo "  make coverage     Run tests with coverage"
	@echo "  make fmt          Format code"
	@echo "  make vet          Run go vet"
	@echo "  make lint         Run linter"
	@echo "  make security     Run security scan"
	@echo "  make run          Build and run"
	@echo "  make debug        Run in debug mode"
	@echo "  make benchmark    Run benchmark"
	@echo "  make deps         Update dependencies"
	@echo "  make install-tools Install dev tools"
	@echo "  make dist         Create distribution packages"
	@echo "  make docker       Build Docker image"
	@echo "  make docker-run   Run Docker container"
	@echo "  make help         Show this help"

# Default target
.DEFAULT_GOAL := build
