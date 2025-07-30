# Makefile for Otedama P2P Mining Pool

# Variables
BINARY_NAME=otedama
MAIN_PATH=./cmd/otedama
VERSION=$(shell grep "Version = " version.go | cut -d'"' -f2)
BUILD_TIME=$(shell date -u +"%Y-%m-%d %H:%M:%S UTC")
GIT_COMMIT=$(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
LDFLAGS=-ldflags "-X github.com/shizukutanaka/Otedama.Version=$(VERSION) -X 'github.com/shizukutanaka/Otedama.BuildDate=$(BUILD_TIME)' -X github.com/shizukutanaka/Otedama.GitCommit=$(GIT_COMMIT)"

# Go parameters
GOCMD=go
GOBUILD=$(GOCMD) build
GOCLEAN=$(GOCMD) clean
GOTEST=$(GOCMD) test
GOGET=$(GOCMD) get
GOMOD=$(GOCMD) mod
GOVET=$(GOCMD) vet
GOFMT=gofmt

# Targets
.PHONY: all build clean test coverage lint fmt vet install uninstall run help

# Default target
all: clean lint test build

# Build the binary
build:
	@echo "Building $(BINARY_NAME)..."
	$(GOBUILD) $(LDFLAGS) -o $(BINARY_NAME) $(MAIN_PATH)

# Build for multiple platforms
release: clean
	@echo "Building release binaries..."
	# Windows
	GOOS=windows GOARCH=amd64 $(GOBUILD) $(LDFLAGS) -o $(BINARY_NAME)-windows-amd64.exe $(MAIN_PATH)
	GOOS=windows GOARCH=386 $(GOBUILD) $(LDFLAGS) -o $(BINARY_NAME)-windows-386.exe $(MAIN_PATH)
	# Linux
	GOOS=linux GOARCH=amd64 $(GOBUILD) $(LDFLAGS) -o $(BINARY_NAME)-linux-amd64 $(MAIN_PATH)
	GOOS=linux GOARCH=386 $(GOBUILD) $(LDFLAGS) -o $(BINARY_NAME)-linux-386 $(MAIN_PATH)
	GOOS=linux GOARCH=arm64 $(GOBUILD) $(LDFLAGS) -o $(BINARY_NAME)-linux-arm64 $(MAIN_PATH)
	GOOS=linux GOARCH=arm $(GOBUILD) $(LDFLAGS) -o $(BINARY_NAME)-linux-arm $(MAIN_PATH)
	# macOS
	GOOS=darwin GOARCH=amd64 $(GOBUILD) $(LDFLAGS) -o $(BINARY_NAME)-darwin-amd64 $(MAIN_PATH)
	GOOS=darwin GOARCH=arm64 $(GOBUILD) $(LDFLAGS) -o $(BINARY_NAME)-darwin-arm64 $(MAIN_PATH)
	@echo "Release binaries built successfully!"

# Clean build artifacts
clean:
	@echo "Cleaning..."
	$(GOCLEAN)
	rm -f $(BINARY_NAME)
	rm -f $(BINARY_NAME)-*
	rm -rf data/
	rm -rf logs/

# Run tests
test:
	@echo "Running tests..."
	$(GOTEST) -v ./internal/...

# Run tests with coverage
coverage:
	@echo "Running tests with coverage..."
	$(GOTEST) -v -coverprofile=coverage.out ./internal/...
	$(GOCMD) tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report generated: coverage.html"

# Run linter
lint:
	@echo "Running linter..."
	@which golangci-lint > /dev/null || (echo "golangci-lint not installed. Run: go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest" && exit 1)
	golangci-lint run

# Format code
fmt:
	@echo "Formatting code..."
	$(GOFMT) -s -w .

# Run go vet
vet:
	@echo "Running go vet..."
	$(GOVET) ./...

# Download dependencies
deps:
	@echo "Downloading dependencies..."
	$(GOMOD) download
	$(GOMOD) tidy

# Install the binary
install: build
	@echo "Installing $(BINARY_NAME)..."
	@mkdir -p $(HOME)/.local/bin
	@cp $(BINARY_NAME) $(HOME)/.local/bin/
	@echo "Installed to $(HOME)/.local/bin/$(BINARY_NAME)"
	@echo "Make sure $(HOME)/.local/bin is in your PATH"

# Uninstall the binary
uninstall:
	@echo "Uninstalling $(BINARY_NAME)..."
	@rm -f $(HOME)/.local/bin/$(BINARY_NAME)

# Run the application
run: build
	./$(BINARY_NAME)

# Run with default config
run-default: build
	./$(BINARY_NAME) --init
	./$(BINARY_NAME)

# Run benchmarks
benchmark:
	@echo "Running benchmarks..."
	$(GOTEST) -bench=. -benchmem ./internal/zkp/...
	$(GOTEST) -bench=. -benchmem ./internal/mining/...

# Docker build
docker:
	@echo "Building Docker image..."
	docker build -t otedama:$(VERSION) .
	docker tag otedama:$(VERSION) otedama:latest

# Docker compose
docker-compose:
	docker-compose up -d

# Generate documentation
docs:
	@echo "Generating documentation..."
	@which godoc > /dev/null || (echo "godoc not installed. Run: go install golang.org/x/tools/cmd/godoc@latest" && exit 1)
	godoc -http=:6060 &
	@echo "Documentation server started at http://localhost:6060"

# Development mode with hot reload
dev:
	@echo "Starting development mode..."
	@which air > /dev/null || (echo "air not installed. Run: go install github.com/air-verse/air@latest" && exit 1)
	air

# Security scan
security:
	@echo "Running security scan..."
	@which gosec > /dev/null || (echo "gosec not installed. Run: go install github.com/securego/gosec/v2/cmd/gosec@latest" && exit 1)
	gosec ./...

# Help
help:
	@echo "Otedama - P2P Mining Pool with Zero-Knowledge Proof"
	@echo ""
	@echo "Usage:"
	@echo "  make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  all          - Clean, lint, test, and build"
	@echo "  build        - Build the binary"
	@echo "  release      - Build for multiple platforms"
	@echo "  clean        - Remove build artifacts"
	@echo "  test         - Run tests"
	@echo "  coverage     - Run tests with coverage"
	@echo "  lint         - Run linter"
	@echo "  fmt          - Format code"
	@echo "  vet          - Run go vet"
	@echo "  deps         - Download dependencies"
	@echo "  install      - Install the binary"
	@echo "  uninstall    - Uninstall the binary"
	@echo "  run          - Build and run"
	@echo "  run-default  - Run with default config"
	@echo "  benchmark    - Run benchmarks"
	@echo "  docker       - Build Docker image"
	@echo "  docs         - Generate documentation"
	@echo "  dev          - Development mode with hot reload"
	@echo "  security     - Run security scan"
	@echo "  help         - Show this help"

# Quick start for new developers
quickstart: deps build
	@echo ""
	@echo "Otedama built successfully!"
	@echo ""
	@echo "Quick start:"
	@echo "  1. Generate config: ./$(BINARY_NAME) --init"
	@echo "  2. Start mining:    ./$(BINARY_NAME)"
	@echo ""
	@echo "For anonymous mining:"
	@echo "  ./$(BINARY_NAME) --zkp --no-kyc --anonymous"

# Build all components
build-all: build
	@echo "Building all components..."
	$(GOBUILD) -o otedama-cli ./cmd/cli
	$(GOBUILD) -o otedama-dashboard ./cmd/dashboard
	@echo "All components built successfully!"

# Deploy to production
deploy-prod:
	@echo "Deploying to production..."
	./scripts/deploy.sh production

# Deploy to staging
deploy-staging:
	@echo "Deploying to staging..."
	./scripts/deploy.sh staging

# Run integration tests
test-integration:
	@echo "Running integration tests..."
	$(GOTEST) -tags=integration -timeout=20m ./tests/...

# Run all tests (unit + integration)
test-all: test test-integration

# Generate test reports
test-report:
	@echo "Generating test reports..."
	$(GOTEST) -v -json ./... > test-report.json
	@echo "Test report generated: test-report.json"

# Performance profiling
profile:
	@echo "Running performance profiling..."
	$(GOTEST) -cpuprofile=cpu.prof -memprofile=mem.prof -bench=. ./internal/mining/...
	@echo "Profiling data generated: cpu.prof, mem.prof"

# View CPU profile
profile-cpu:
	$(GOCMD) tool pprof -http=:8080 cpu.prof

# View memory profile
profile-mem:
	$(GOCMD) tool pprof -http=:8080 mem.prof

# Check for updates
check-updates:
	@echo "Checking for dependency updates..."
	$(GOCMD) list -u -m all

# Update dependencies
update-deps:
	@echo "Updating dependencies..."
	$(GOCMD) get -u ./...
	$(GOMOD) tidy

# Generate mocks for testing
mocks:
	@echo "Generating mocks..."
	@which mockgen > /dev/null || (echo "mockgen not installed. Run: go install github.com/golang/mock/mockgen@latest" && exit 1)
	mockgen -source=internal/mining/engine.go -destination=internal/mining/mocks/engine_mock.go
	mockgen -source=internal/zkp/protocols.go -destination=internal/zkp/mocks/protocols_mock.go

# Static analysis
analyze: lint vet security
	@echo "Static analysis complete"

# CI/CD pipeline
ci: clean deps analyze test-all build
	@echo "CI pipeline complete"

# Full release process
release-full: clean test-all release
	@echo "Creating release archives..."
	tar czf otedama-$(VERSION)-windows.tar.gz $(BINARY_NAME)-windows-*.exe
	tar czf otedama-$(VERSION)-linux.tar.gz $(BINARY_NAME)-linux-*
	tar czf otedama-$(VERSION)-darwin.tar.gz $(BINARY_NAME)-darwin-*
	@echo "Release archives created"

# Development setup
dev-setup:
	@echo "Setting up development environment..."
	$(GOCMD) install github.com/air-verse/air@latest
	$(GOCMD) install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
	$(GOCMD) install github.com/securego/gosec/v2/cmd/gosec@latest
	$(GOCMD) install github.com/golang/mock/mockgen@latest
	@echo "Development environment ready!"
