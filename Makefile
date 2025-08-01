# Otedama Makefile
# Following Rob Pike's principle: "Make it easy to do the right thing"

# Variables
BINARY_NAME=otedama
VERSION=$(shell git describe --tags --always --dirty)
BUILD_TIME=$(shell date -u '+%Y-%m-%d_%H:%M:%S')
COMMIT_HASH=$(shell git rev-parse --short HEAD)
GO_VERSION=$(shell go version | awk '{print $$3}')

# Build flags
LDFLAGS=-ldflags "-X main.Version=${VERSION} -X main.BuildTime=${BUILD_TIME} -X main.CommitHash=${COMMIT_HASH} -s -w"
GCFLAGS=-gcflags="all=-N -l"
TAGS=-tags "production"

# Directories
CMD_DIR=./cmd/otedama
BIN_DIR=./bin
DIST_DIR=./dist

# Default target
.PHONY: all
all: clean test build

# Build targets
.PHONY: build
build: build-linux build-windows build-darwin

.PHONY: build-linux
build-linux:
	@echo "Building for Linux..."
	@mkdir -p $(BIN_DIR)
	GOOS=linux GOARCH=amd64 go build $(LDFLAGS) $(TAGS) -o $(BIN_DIR)/$(BINARY_NAME)-linux-amd64 $(CMD_DIR)
	GOOS=linux GOARCH=arm64 go build $(LDFLAGS) $(TAGS) -o $(BIN_DIR)/$(BINARY_NAME)-linux-arm64 $(CMD_DIR)

.PHONY: build-windows
build-windows:
	@echo "Building for Windows..."
	@mkdir -p $(BIN_DIR)
	GOOS=windows GOARCH=amd64 go build $(LDFLAGS) $(TAGS) -o $(BIN_DIR)/$(BINARY_NAME)-windows-amd64.exe $(CMD_DIR)

.PHONY: build-darwin
build-darwin:
	@echo "Building for macOS..."
	@mkdir -p $(BIN_DIR)
	GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) $(TAGS) -o $(BIN_DIR)/$(BINARY_NAME)-darwin-amd64 $(CMD_DIR)
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) $(TAGS) -o $(BIN_DIR)/$(BINARY_NAME)-darwin-arm64 $(CMD_DIR)

.PHONY: build-debug
build-debug:
	@echo "Building debug version..."
	@mkdir -p $(BIN_DIR)
	go build $(GCFLAGS) -tags debug -o $(BIN_DIR)/$(BINARY_NAME)-debug $(CMD_DIR)

.PHONY: build-cpu
build-cpu:
	@echo "Building CPU-only version..."
	@mkdir -p $(BIN_DIR)
	go build $(LDFLAGS) -tags "cpu_only" -o $(BIN_DIR)/$(BINARY_NAME)-cpu $(CMD_DIR)

.PHONY: build-gpu
build-gpu:
	@echo "Building GPU-enabled version..."
	@mkdir -p $(BIN_DIR)
	go build $(LDFLAGS) -tags "gpu cuda opencl" -o $(BIN_DIR)/$(BINARY_NAME)-gpu $(CMD_DIR)

.PHONY: build-enterprise
build-enterprise:
	@echo "Building enterprise version..."
	@mkdir -p $(BIN_DIR)
	go build $(LDFLAGS) -tags "enterprise gpu cuda opencl" -o $(BIN_DIR)/$(BINARY_NAME)-enterprise $(CMD_DIR)

# Test targets
.PHONY: test
test:
	@echo "Running tests..."
	go test -v -race -coverprofile=coverage.out ./...

.PHONY: test-short
test-short:
	@echo "Running short tests..."
	go test -v -short ./...

.PHONY: test-integration
test-integration:
	@echo "Running integration tests..."
	go test -v -tags integration ./tests/integration/...

.PHONY: test-benchmark
test-benchmark:
	@echo "Running benchmarks..."
	go test -bench=. -benchmem ./...

.PHONY: coverage
coverage: test
	@echo "Generating coverage report..."
	go tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report generated: coverage.html"

# Development targets
.PHONY: run
run: build-debug
	@echo "Running Otedama..."
	$(BIN_DIR)/$(BINARY_NAME)-debug

.PHONY: dev
dev:
	@echo "Starting development mode with hot reload..."
	air -c .air.toml

.PHONY: fmt
fmt:
	@echo "Formatting code..."
	go fmt ./...
	gofumpt -w .

.PHONY: lint
lint:
	@echo "Running linters..."
	golangci-lint run --timeout 5m

.PHONY: vet
vet:
	@echo "Running go vet..."
	go vet ./...

.PHONY: mod
mod:
	@echo "Tidying modules..."
	go mod tidy
	go mod verify

# Installation targets
.PHONY: install
install: build
	@echo "Installing Otedama..."
	@mkdir -p ~/.local/bin
	@cp $(BIN_DIR)/$(BINARY_NAME)-$(shell go env GOOS)-$(shell go env GOARCH)* ~/.local/bin/$(BINARY_NAME)
	@chmod +x ~/.local/bin/$(BINARY_NAME)
	@echo "Installed to ~/.local/bin/$(BINARY_NAME)"

.PHONY: uninstall
uninstall:
	@echo "Uninstalling Otedama..."
	@rm -f ~/.local/bin/$(BINARY_NAME)
	@echo "Uninstalled"

# Release targets
.PHONY: release
release: clean test build
	@echo "Creating release packages..."
	@mkdir -p $(DIST_DIR)
	
	# Linux packages
	tar -czf $(DIST_DIR)/$(BINARY_NAME)-$(VERSION)-linux-amd64.tar.gz -C $(BIN_DIR) $(BINARY_NAME)-linux-amd64
	tar -czf $(DIST_DIR)/$(BINARY_NAME)-$(VERSION)-linux-arm64.tar.gz -C $(BIN_DIR) $(BINARY_NAME)-linux-arm64
	
	# Windows package
	cd $(BIN_DIR) && zip ../$(DIST_DIR)/$(BINARY_NAME)-$(VERSION)-windows-amd64.zip $(BINARY_NAME)-windows-amd64.exe
	
	# macOS packages
	tar -czf $(DIST_DIR)/$(BINARY_NAME)-$(VERSION)-darwin-amd64.tar.gz -C $(BIN_DIR) $(BINARY_NAME)-darwin-amd64
	tar -czf $(DIST_DIR)/$(BINARY_NAME)-$(VERSION)-darwin-arm64.tar.gz -C $(BIN_DIR) $(BINARY_NAME)-darwin-arm64
	
	# Generate checksums
	cd $(DIST_DIR) && sha256sum * > checksums.txt
	
	@echo "Release packages created in $(DIST_DIR)"

# Docker targets
.PHONY: docker-build
docker-build:
	@echo "Building Docker image..."
	docker build -t otedama:$(VERSION) -t otedama:latest .

.PHONY: docker-push
docker-push: docker-build
	@echo "Pushing Docker image..."
	docker tag otedama:$(VERSION) ghcr.io/shizukutanaka/otedama:$(VERSION)
	docker tag otedama:latest ghcr.io/shizukutanaka/otedama:latest
	docker push ghcr.io/shizukutanaka/otedama:$(VERSION)
	docker push ghcr.io/shizukutanaka/otedama:latest

# Utility targets
.PHONY: clean
clean:
	@echo "Cleaning build artifacts..."
	@rm -rf $(BIN_DIR) $(DIST_DIR)
	@rm -f coverage.out coverage.html
	@go clean -cache -testcache -modcache

.PHONY: deps
deps:
	@echo "Installing dependencies..."
	go mod download
	
	@echo "Installing development tools..."
	go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
	go install mvdan.cc/gofumpt@latest
	go install github.com/cosmtrek/air@latest
	go install github.com/securego/gosec/v2/cmd/gosec@latest

.PHONY: security
security:
	@echo "Running security scan..."
	gosec -fmt json -out security-report.json ./...
	@echo "Security report generated: security-report.json"

.PHONY: benchmark
benchmark:
	@echo "Running comprehensive benchmark..."
	go run ./cmd/benchmark -duration 60s -output benchmark-results.json

.PHONY: profile
profile:
	@echo "Running CPU profile..."
	go test -cpuprofile cpu.prof -bench=. ./internal/mining
	go tool pprof -http=:8080 cpu.prof

.PHONY: docs
docs:
	@echo "Generating documentation..."
	go doc -all > API_DOCS.txt
	@echo "API documentation generated: API_DOCS.txt"

# System check
.PHONY: check
check:
	@echo "System check..."
	@echo "Go version: $(GO_VERSION)"
	@echo "Version: $(VERSION)"
	@echo "Commit: $(COMMIT_HASH)"
	@echo "Build time: $(BUILD_TIME)"
	@echo ""
	@echo "Checking tools..."
	@which golangci-lint > /dev/null && echo "✓ golangci-lint installed" || echo "✗ golangci-lint not installed"
	@which gofumpt > /dev/null && echo "✓ gofumpt installed" || echo "✗ gofumpt not installed"
	@which air > /dev/null && echo "✓ air installed" || echo "✗ air not installed"
	@which gosec > /dev/null && echo "✓ gosec installed" || echo "✗ gosec not installed"

# CI/CD targets
.PHONY: ci
ci: clean deps lint test security build

.PHONY: cd
cd: ci docker-build docker-push

# Help target
.PHONY: help
help:
	@echo "Otedama Makefile"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@echo "Build targets:"
	@echo "  build              Build for all platforms"
	@echo "  build-linux        Build for Linux (amd64, arm64)"
	@echo "  build-windows      Build for Windows (amd64)"
	@echo "  build-darwin       Build for macOS (amd64, arm64)"
	@echo "  build-debug        Build debug version"
	@echo "  build-cpu          Build CPU-only version"
	@echo "  build-gpu          Build GPU-enabled version"
	@echo "  build-enterprise   Build enterprise version"
	@echo ""
	@echo "Test targets:"
	@echo "  test               Run all tests with coverage"
	@echo "  test-short         Run short tests only"
	@echo "  test-integration   Run integration tests"
	@echo "  test-benchmark     Run benchmarks"
	@echo "  coverage           Generate coverage report"
	@echo ""
	@echo "Development targets:"
	@echo "  run                Build and run debug version"
	@echo "  dev                Start with hot reload"
	@echo "  fmt                Format code"
	@echo "  lint               Run linters"
	@echo "  vet                Run go vet"
	@echo "  mod                Tidy modules"
	@echo ""
	@echo "Installation targets:"
	@echo "  install            Install to ~/.local/bin"
	@echo "  uninstall          Uninstall from system"
	@echo ""
	@echo "Release targets:"
	@echo "  release            Create release packages"
	@echo "  docker-build       Build Docker image"
	@echo "  docker-push        Push Docker image"
	@echo ""
	@echo "Utility targets:"
	@echo "  clean              Clean build artifacts"
	@echo "  deps               Install dependencies"
	@echo "  security           Run security scan"
	@echo "  benchmark          Run comprehensive benchmark"
	@echo "  profile            Run CPU profiling"
	@echo "  docs               Generate documentation"
	@echo "  check              System check"
	@echo "  help               Show this help"

# Default help
.DEFAULT_GOAL := help