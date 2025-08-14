# Otedama Makefile
# High-performance P2P mining pool and mining software

# Application metadata
APP_NAME := otedama
VERSION := 2.1.5
BUILD_DATE := $(shell date -u +"%Y-%m-%d %H:%M:%S")
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Go parameters
GOCMD := go
GOBUILD := $(GOCMD) build
GOCLEAN := $(GOCMD) clean
GOTEST := $(GOCMD) test
GOGET := $(GOCMD) get
GOMOD := $(GOCMD) mod
GOFMT := gofmt
GOLINT := golangci-lint
GOVET := $(GOCMD) vet

# Windows-specific toolchain handling
ifeq ($(OS),Windows_NT)
	SHELL := cmd
	GOCMD := go.exe
	DETECTED_OS := Windows
else
	DETECTED_OS := $(shell uname -s)
endif

# Ensure Go is available
GO_CHECK := $(shell which $(GOCMD) 2>/dev/null || echo "NOT_FOUND")
ifeq ($(GO_CHECK),NOT_FOUND)
	$(error Go toolchain not found. Please install Go from https://golang.org/dl/)
endif

# Build directories
BUILD_DIR := build
BIN_DIR := $(BUILD_DIR)/bin
DIST_DIR := $(BUILD_DIR)/dist

# Source directories
CMD_DIR := cmd
INTERNAL_DIR := internal
PKG_DIR := pkg

# Main package
MAIN_PACKAGE := ./$(CMD_DIR)/otedama

# Binary name
BINARY_NAME := $(APP_NAME)
BINARY_UNIX := $(BINARY_NAME)
BINARY_WINDOWS := $(BINARY_NAME).exe

# Build flags
LDFLAGS := -ldflags "\
	-X 'main.AppVersion=$(VERSION)' \
	-X 'main.AppBuild=$(BUILD_DATE)' \
	-X 'main.GitCommit=$(GIT_COMMIT)' \
	-s -w"

# Build tags
BUILD_TAGS := 

# CGO settings
CGO_ENABLED := 1

# Platform-specific settings
UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)

ifeq ($(UNAME_S),Linux)
	PLATFORM := linux
endif
ifeq ($(UNAME_S),Darwin)
	PLATFORM := darwin
endif
ifeq ($(OS),Windows_NT)
	PLATFORM := windows
	BINARY_NAME := $(BINARY_WINDOWS)
endif

ifeq ($(UNAME_M),x86_64)
	ARCH := amd64
endif
ifeq ($(UNAME_M),aarch64)
	ARCH := arm64
endif
ifeq ($(UNAME_M),arm64)
	ARCH := arm64
endif

# Feature flags
ENABLE_GPU ?= 1
ENABLE_CUDA ?= 1
ENABLE_OPENCL ?= 1

# GPU build tags
ifeq ($(ENABLE_GPU),1)
	BUILD_TAGS := $(BUILD_TAGS),gpu
	ifeq ($(ENABLE_CUDA),1)
		BUILD_TAGS := $(BUILD_TAGS),cuda
	endif
	ifeq ($(ENABLE_OPENCL),1)
		BUILD_TAGS := $(BUILD_TAGS),opencl
	endif
endif

# Default target
.DEFAULT_GOAL := build

# Phony targets
.PHONY: all build build-all clean test bench coverage lint fmt vet release help version deps deps-clean deps-verify deps-update deps-check fmt vet \
	deps deps-update install uninstall run debug release \
	docker docker-push proto docs docs-clean url-guard help \
	build-linux build-darwin build-windows cross-compile

# Help target
help: ## Show this help message
	@echo "Otedama Build System"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'
	@echo ""
	@echo "Variables:"
	@echo "  ENABLE_GPU=$(ENABLE_GPU)     Enable GPU support"
	@echo "  ENABLE_CUDA=$(ENABLE_CUDA)    Enable CUDA support"
	@echo "  ENABLE_OPENCL=$(ENABLE_OPENCL)  Enable OpenCL support"

# Build targets
all: clean deps lint test build ## Clean, install deps, lint, test, and build

build: ## Build the binary for current platform
	@echo "Building $(APP_NAME) v$(VERSION) for $(PLATFORM)/$(ARCH)..."
	@mkdir -p $(BIN_DIR)
	CGO_ENABLED=$(CGO_ENABLED) $(GOBUILD) $(LDFLAGS) -tags "$(BUILD_TAGS)" -o $(BIN_DIR)/$(BINARY_NAME) $(MAIN_PACKAGE)
	@echo "Build complete: $(BIN_DIR)/$(BINARY_NAME)"

build-all: build-linux build-darwin build-windows ## Build for all platforms

build-linux: ## Build for Linux
	@echo "Building for Linux..."
	@mkdir -p $(BIN_DIR)/linux
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 $(GOBUILD) $(LDFLAGS) -o $(BIN_DIR)/linux/$(BINARY_UNIX)-amd64 $(MAIN_PACKAGE)
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 $(GOBUILD) $(LDFLAGS) -o $(BIN_DIR)/linux/$(BINARY_UNIX)-arm64 $(MAIN_PACKAGE)

build-darwin: ## Build for macOS
	@echo "Building for macOS..."
	@mkdir -p $(BIN_DIR)/darwin
	GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 $(GOBUILD) $(LDFLAGS) -o $(BIN_DIR)/darwin/$(BINARY_UNIX)-amd64 $(MAIN_PACKAGE)
	GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 $(GOBUILD) $(LDFLAGS) -o $(BIN_DIR)/darwin/$(BINARY_UNIX)-arm64 $(MAIN_PACKAGE)

build-windows: ## Build for Windows
	@echo "Building for Windows..."
	@mkdir -p $(BIN_DIR)/windows
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 $(GOBUILD) $(LDFLAGS) -o $(BIN_DIR)/windows/$(BINARY_WINDOWS)-amd64.exe $(MAIN_PACKAGE)

cross-compile: build-all ## Cross-compile for all platforms

# Build with specific features
build-cpu: ## Build CPU-only version
	@echo "Building CPU-only version..."
	@mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 $(GOBUILD) $(LDFLAGS) -tags "cpu" -o $(BIN_DIR)/$(BINARY_NAME)-cpu $(MAIN_PACKAGE)

build-gpu: ## Build GPU-enabled version
	@echo "Building GPU-enabled version..."
	@mkdir -p $(BIN_DIR)
	CGO_ENABLED=1 $(GOBUILD) $(LDFLAGS) -tags "gpu,cuda,opencl" -o $(BIN_DIR)/$(BINARY_NAME)-gpu $(MAIN_PACKAGE)

build-asic: ## Build ASIC-enabled version
	@echo "Building ASIC-enabled version..."
	@mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 $(GOBUILD) $(LDFLAGS) -tags "asic" -o $(BIN_DIR)/$(BINARY_NAME)-asic $(MAIN_PACKAGE)

# Debug and release builds
debug: ## Build debug version with symbols
	@echo "Building debug version..."
	@mkdir -p $(BIN_DIR)
	CGO_ENABLED=$(CGO_ENABLED) $(GOBUILD) -gcflags="all=-N -l" -tags "$(BUILD_TAGS),debug" -o $(BIN_DIR)/$(BINARY_NAME)-debug $(MAIN_PACKAGE)

release: ## Build optimized release version
	@echo "Building release version..."
	@mkdir -p $(BIN_DIR)
	CGO_ENABLED=$(CGO_ENABLED) $(GOBUILD) $(LDFLAGS) -tags "$(BUILD_TAGS)" -o $(BIN_DIR)/$(BINARY_NAME) $(MAIN_PACKAGE)
	@echo "Stripping binary..."
	@strip $(BIN_DIR)/$(BINARY_NAME) 2>/dev/null || true

# Installation targets
install: build ## Install binary to system
	@echo "Installing $(APP_NAME)..."
	@install -d /usr/local/bin
	@install -m 755 $(BIN_DIR)/$(BINARY_NAME) /usr/local/bin/$(APP_NAME)
	@echo "Installed to /usr/local/bin/$(APP_NAME)"

uninstall: ## Uninstall binary from system
	@echo "Uninstalling $(APP_NAME)..."
	@rm -f /usr/local/bin/$(APP_NAME)
	@echo "Uninstalled from /usr/local/bin/$(APP_NAME)"

# Run targets
run: build ## Build and run the application
	@echo "Running $(APP_NAME)..."
	@$(BIN_DIR)/$(BINARY_NAME)

run-debug: debug ## Build and run debug version
	@echo "Running $(APP_NAME) in debug mode..."
	@$(BIN_DIR)/$(BINARY_NAME)-debug --debug --verbose

# Testing targets
test: ## Run unit tests
	@echo "Running tests..."
	@$(GOTEST) -v -race -coverprofile=coverage.out ./...

test-short: ## Run short tests
	@echo "Running short tests..."
	@$(GOTEST) -v -short ./...

test-integration: ## Run integration tests
	@echo "Running integration tests..."
	@$(GOTEST) -v -tags=integration ./test/integration/...

test-e2e: ## Run end-to-end tests
	@echo "Running e2e tests..."
	@$(GOTEST) -v -tags=e2e ./test/e2e/...

bench: ## Run benchmarks
	@echo "Running benchmarks..."
	@$(GOTEST) -bench=. -benchmem ./...

coverage: test ## Generate test coverage report
	@echo "Generating coverage report..."
	@$(GOCMD) tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report generated: coverage.html"

# Code quality targets
lint: ## Run linter
	@echo "Running linter..."
	$(GOLINT) run ./...

fmt: ## Format code
	@echo "Formatting code..."
	$(GOFMT) -w .

vet: ## Run go vet
	@echo "Running go vet..."
	$(GOVET) ./...

check: docs-clean url-guard lint vet ## Run all code and URL checks

# Dependency management
deps: ## Install dependencies
	@echo "Installing dependencies..."
	$(GOMOD) tidy
	$(GOMOD) verify

deps-clean: ## Clean module cache and dependencies
	@echo "Cleaning dependencies..."
	$(GOMOD) tidy -compat=1.23
	$(GOMOD) verify

deps-verify: ## Verify module integrity
	@echo "Verifying dependencies..."
	$(GOMOD) verify

deps-update: ## Update all dependencies
	@echo "Updating dependencies..."
	$(GOMOD) tidy -compat=1.23
	$(GOMOD) download

deps-check: ## Check for dependency issues
	@echo "Checking for dependency issues..."
	$(GOCMD) mod verify
	$(GOCMD) list -m -u all

# Windows-specific targets
ifeq ($(DETECTED_OS),Windows)
fix-deps:
	@echo "Fixing Windows Go module issues..."
	powershell -Command "go mod tidy -compat=1.23"
	powershell -Command "go mod verify"
	powershell -Command "go build -v ./..."
else
fix-deps:
	@echo "Fixing Unix Go module issues..."
	$(GOMOD) tidy -compat=1.23
	$(GOMOD) verify
	$(GOCMD) build -v ./...
endif

# Clean targets
clean: ## Clean build artifacts
	@echo "Cleaning build artifacts..."
	@$(GOCLEAN)
	@rm -rf $(BUILD_DIR)
	@rm -f coverage.out coverage.html
	@echo "Clean complete"

clean-all: clean ## Clean everything including dependencies
	@echo "Cleaning everything..."
	@rm -rf vendor/
	@$(GOMOD) clean -cache

# Docker targets
docker: ## Build Docker image
	@echo "Building Docker image..."
	@docker build -t $(APP_NAME):$(VERSION) .
	@docker tag $(APP_NAME):$(VERSION) $(APP_NAME):latest

docker-push: docker ## Push Docker image to registry
	@echo "Pushing Docker image..."
	@docker push $(APP_NAME):$(VERSION)
	@docker push $(APP_NAME):latest

docker-run: docker ## Run in Docker container
	@echo "Running in Docker..."
	@docker run -it --rm -p 8333:8333 -p 9090:9090 $(APP_NAME):latest

# Distribution targets
dist: release ## Create distribution packages
	@echo "Creating distribution packages..."
	@mkdir -p $(DIST_DIR)
	@tar -czf $(DIST_DIR)/$(APP_NAME)-$(VERSION)-$(PLATFORM)-$(ARCH).tar.gz -C $(BIN_DIR) $(BINARY_NAME)
	@zip -j $(DIST_DIR)/$(APP_NAME)-$(VERSION)-$(PLATFORM)-$(ARCH).zip $(BIN_DIR)/$(BINARY_NAME)
	@echo "Distribution packages created in $(DIST_DIR)"

dist-all: build-all ## Create distribution packages for all platforms
	@echo "Creating distribution packages for all platforms..."
	@mkdir -p $(DIST_DIR)
	@for os in linux darwin windows; do \
		for arch in amd64 arm64; do \
			if [ -f $(BIN_DIR)/$$os/$(BINARY_UNIX)-$$arch ]; then \
				tar -czf $(DIST_DIR)/$(APP_NAME)-$(VERSION)-$$os-$$arch.tar.gz -C $(BIN_DIR)/$$os $(BINARY_UNIX)-$$arch; \
			fi; \
		done; \
	done
	@echo "All distribution packages created in $(DIST_DIR)"

# Documentation targets
docs: ## Generate documentation
	@echo "Generating documentation..."
	@$(GOCMD) doc -all ./... > docs/api.txt
	@godoc -http=:6060 &
	@echo "Documentation server started at http://localhost:6060"

# Documentation cleanup and URL guard
ifeq ($(DETECTED_OS),Windows)
docs-clean: ## Normalize documentation URLs (Windows)
	@echo "Cleaning documentation URLs..."
	powershell -ExecutionPolicy Bypass -File scripts/cleanup-doc-urls.ps1

url-guard: ## Validate repository URLs against allow-list (Windows)
	@echo "Running URL guard..."
	bash scripts/url_guard.sh
else
docs-clean: ## Normalize documentation URLs (Unix)
	@echo "Cleaning documentation URLs..."
	bash scripts/cleanup-doc-urls.sh

url-guard: ## Validate repository URLs against allow-list (Unix)
	@echo "Running URL guard..."
	bash scripts/url_guard.sh
endif

# Development targets
dev: ## Run in development mode with hot reload
	@echo "Starting development mode..."
	@which air > /dev/null || (echo "Installing air..." && go install github.com/cosmtrek/air@latest)
	@air

generate: ## Run go generate
	@echo "Running go generate..."
	@$(GOCMD) generate ./...

proto: ## Generate protobuf code
	@echo "Generating protobuf code..."
	@protoc --go_out=. --go-grpc_out=. proto/*.proto

# Utility targets
info: ## Display build information
	@echo "Application: $(APP_NAME)"
	@echo "Build Date: $(BUILD_DATE)"
	@echo "Git Commit: $(GIT_COMMIT)"
	@echo "Platform: $(PLATFORM)"
	@echo "Architecture: $(ARCH)"
	@echo "Build Tags: $(BUILD_TAGS)"
	@echo "CGO Enabled: $(CGO_ENABLED)"

# CI/CD targets
ci: clean deps docs-clean url-guard lint test build ## Run CI pipeline with URL guard
	@echo "CI pipeline complete"

cd: ci dist docker-push ## Run CD pipeline
	@echo "CD pipeline complete"

# Performance profiling
profile-cpu: ## Run CPU profiling
	@echo "Running CPU profiling..."
	@$(GOTEST) -cpuprofile=cpu.prof -bench=.
	@$(GOCMD) tool pprof cpu.prof

profile-mem: ## Run memory profiling
	@echo "Running memory profiling..."
	@$(GOTEST) -memprofile=mem.prof -bench=.
	@$(GOCMD) tool pprof mem.prof

# Security scanning
security: ## Run security scan
	@echo "Running security scan..."
	@which gosec > /dev/null || (echo "Installing gosec..." && go install github.com/securego/gosec/v2/cmd/gosec@latest)
	@gosec ./...

# Default config generation
config: ## Generate default configuration file
	@echo "Generating default configuration..."
	@$(BIN_DIR)/$(BINARY_NAME) --generate-config