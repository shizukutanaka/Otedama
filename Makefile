# Otedama Makefile
# Professional build system for Otedama mining software

# Variables
BINARY_NAME := otedama
BINARY_DIR := bin
GO := go
GOFLAGS := -v
LDFLAGS := -w -s
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo "v2.1.2")
BUILD_TIME := $(shell date -u '+%Y-%m-%d_%H:%M:%S')
COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Build tags
TAGS := ""

# Platforms
PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64

# Commands
.PHONY: all build clean test bench lint fmt vet install help

# Default target
all: clean build

# Help
help:
	@echo "Otedama Build System"
	@echo ""
	@echo "Usage:"
	@echo "  make build       - Build the binary"
	@echo "  make install     - Install the binary"
	@echo "  make test        - Run tests"
	@echo "  make bench       - Run benchmarks"
	@echo "  make lint        - Run linters"
	@echo "  make fmt         - Format code"
	@echo "  make clean       - Clean build artifacts"
	@echo "  make docker      - Build Docker image"
	@echo "  make release     - Build all platforms"
	@echo ""

# Build binary
build:
	@echo "Building $(BINARY_NAME)..."
	@mkdir -p $(BINARY_DIR)
	$(GO) build $(GOFLAGS) -tags $(TAGS) -ldflags "$(LDFLAGS) \
		-X main.AppVersion=$(VERSION) \
		-X main.AppBuild=$(BUILD_TIME) \
		-X main.AppCommit=$(COMMIT)" \
		-o $(BINARY_DIR)/$(BINARY_NAME) cmd/otedama/main.go
	@echo "Build complete: $(BINARY_DIR)/$(BINARY_NAME)"

# Install binary
install: build
	@echo "Installing $(BINARY_NAME)..."
	$(GO) install $(GOFLAGS) -tags $(TAGS) -ldflags "$(LDFLAGS)" ./cmd/otedama
	@echo "Installation complete"

# Run tests
test:
	@echo "Running tests..."
	$(GO) test -v -race -coverprofile=coverage.out ./...
	@echo "Tests complete"

# Run integration tests
test-integration:
	@echo "Running integration tests..."
	$(GO) test -v -tags=integration -timeout 30m ./tests/integration/...
	@echo "Integration tests complete"

# Run benchmarks
bench:
	@echo "Running benchmarks..."
	$(GO) test -bench=. -benchmem -run=^$$ ./...
	@echo "Benchmarks complete"

# Format code
fmt:
	@echo "Formatting code..."
	$(GO) fmt ./...
	@gofmt -s -w .
	@echo "Formatting complete"

# Vet code
vet:
	@echo "Vetting code..."
	$(GO) vet ./...
	@echo "Vetting complete"

# Lint code
lint: fmt vet
	@echo "Linting code..."
	@if command -v golangci-lint > /dev/null; then \
		golangci-lint run ./...; \
	else \
		echo "golangci-lint not installed"; \
	fi
	@echo "Linting complete"

# Clean build artifacts
clean:
	@echo "Cleaning..."
	@rm -rf $(BINARY_DIR)
	@rm -f coverage.out
	@rm -f *.prof
	@rm -f *.test
	@$(GO) clean -cache
	@echo "Clean complete"

# Build Docker image
docker:
	@echo "Building Docker image..."
	docker build -t otedama:$(VERSION) -t otedama:latest .
	@echo "Docker build complete"

# Cross-platform builds
release:
	@echo "Building releases..."
	@mkdir -p $(BINARY_DIR)/release
	@for platform in $(PLATFORMS); do \
		GOOS=$$(echo $$platform | cut -d/ -f1); \
		GOARCH=$$(echo $$platform | cut -d/ -f2); \
		output=$(BINARY_DIR)/release/$(BINARY_NAME)-$$GOOS-$$GOARCH; \
		if [ "$$GOOS" = "windows" ]; then output="$$output.exe"; fi; \
		echo "Building for $$GOOS/$$GOARCH..."; \
		GOOS=$$GOOS GOARCH=$$GOARCH $(GO) build $(GOFLAGS) \
			-tags $(TAGS) -ldflags "$(LDFLAGS)" \
			-o $$output cmd/otedama/main.go; \
	done
	@echo "Release builds complete"

# Generate code
generate:
	@echo "Generating code..."
	$(GO) generate ./...
	@echo "Generation complete"

# Run the application
run: build
	@echo "Running $(BINARY_NAME)..."
	./$(BINARY_DIR)/$(BINARY_NAME)

# Development setup
dev-setup:
	@echo "Setting up development environment..."
	$(GO) install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
	$(GO) install golang.org/x/tools/cmd/goimports@latest
	$(GO) install github.com/swaggo/swag/cmd/swag@latest
	@echo "Development setup complete"

# Update dependencies
deps:
	@echo "Updating dependencies..."
	$(GO) mod download
	$(GO) mod tidy
	@echo "Dependencies updated"

# Security scan
security:
	@echo "Running security scan..."
	@if command -v gosec > /dev/null; then \
		gosec ./...; \
	else \
		echo "gosec not installed"; \
	fi
	@echo "Security scan complete"

# Code coverage
coverage: test
	@echo "Generating coverage report..."
	$(GO) tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report generated: coverage.html"

# Profile CPU
profile-cpu:
	@echo "CPU profiling..."
	$(GO) test -cpuprofile=cpu.prof -bench=. ./internal/mining
	$(GO) tool pprof -http=:8080 cpu.prof

# Profile memory
profile-mem:
	@echo "Memory profiling..."
	$(GO) test -memprofile=mem.prof -bench=. ./internal/mining
	$(GO) tool pprof -http=:8080 mem.prof

# Check for updates
check-updates:
	@echo "Checking for dependency updates..."
	$(GO) list -u -m all

# CI/CD targets
ci: clean lint test build
	@echo "CI pipeline complete"

# Quick build (no clean)
quick: build

# Version info
version:
	@echo "Version: $(VERSION)"
	@echo "Commit: $(COMMIT)"
	@echo "Build Time: $(BUILD_TIME)"