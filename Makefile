# Otedama Makefile
#
# This Makefile provides a comprehensive set of commands for building, testing,
# and managing the Otedama project. It is designed to be efficient and easy to use
# for both development and production workflows.

# ==============================================================================
# Go Configuration
# ==============================================================================
GOCMD   := go
GOBUILD := $(GOCMD) build
GOCLEAN := $(GOCMD) clean
GOTEST  := $(GOCMD) test
GOMOD   := $(GOCMD) mod
GOFMT   := $(GOCMD) fmt
GOVET   := $(GOCMD) vet
GOGET   := $(GOCMD) get

# ==============================================================================
# Project Configuration
# ==============================================================================
# Binary names
BINARY_NAME        := otedama
BENCHMARK_BINARY   := benchmark
SECURITY_BINARY    := security-audit
BINARY_WINDOWS     := $(BINARY_NAME).exe

# Directories
BIN_DIR      := bin
BUILD_DIR    := build
DIST_DIR     := dist
PROFILE_DIR  := $(BUILD_DIR)/profiles

# ==============================================================================
# Build Configuration
# ==============================================================================
# Version info (dynamically sourced from Git)
VERSION      ?= $(shell git describe --tags --always --dirty)
BUILD_TIME   := $(shell date -u +%Y-%m-%d_%H:%M:%S)
GIT_COMMIT   := $(shell git rev-parse --short HEAD)

# Go build flags
# -s: Omit the symbol table and debug information.
# -w: Omit the DWARF symbol table.
# -trimpath: Remove all file system paths from the resulting executable.
# -X: Set string value at import path.
BUILDFLAGS      := -trimpath
LDFLAGS         := -ldflags="-s -w"
LDFLAGS_VERSION := -ldflags="-s -w -X main.Version=$(VERSION) -X main.BuildTime=$(BUILD_TIME) -X main.GitCommit=$(GIT_COMMIT)"

# ==============================================================================
# Tooling Configuration
# ==============================================================================
GOLINT      := golangci-lint
AIR         := air
GORELEASER  := goreleaser

.PHONY: all build build-all build-race build-cross clean test coverage bench lint fmt vet install uninstall deps tidy verify run docker help

# ==============================================================================
# Default Target
# ==============================================================================
all: build

# ==============================================================================
# Help Target
# ==============================================================================
help:
	@echo "Otedama Build System"
	@echo "--------------------"
	@echo "Usage: make [target]"
	@echo ""
	@echo "Main Targets:"
	@echo "  all                - Build the main Otedama binary (default)."
	@echo "  build              - Build the main Otedama binary."
	@echo "  build-all          - Build all project binaries (main, benchmark, security)."
	@echo "  run                - Build and run the main application."
	@echo "  install            - Build and install the main binary to $$GOPATH/bin."
	@echo "  uninstall          - Remove the binary from $$GOPATH/bin."
	@echo "  clean              - Remove all build artifacts and binaries."
	@echo ""
	@echo "Development & QA:"
	@echo "  test               - Run all tests with the race detector."
	@echo "  coverage           - Run tests and generate an HTML coverage report."
	@echo "  bench              - Run all benchmarks."
	@echo "  lint               - Run the linter."
	@echo "  fmt                - Format all Go source code."
	@echo "  vet                - Run 'go vet' to check for suspicious constructs."
	@echo "  check              - Run fmt, vet, lint, and test targets."
	@echo "  deps               - Download Go module dependencies."
	@echo "  tidy               - Tidy Go module dependencies."
	@echo "  watch              - Watch for file changes and automatically rebuild."
	@echo ""
	@echo "Cross-Compilation:"
	@echo "  build-cross        - Build for Linux, Windows, and macOS."
	@echo "  build-linux        - Build for Linux (amd64)."
	@echo "  build-windows      - Build for Windows (amd64)."
	@echo "  build-darwin       - Build for macOS (amd64)."
	@echo ""
	@echo "Docker:"
	@echo "  docker             - Build the Docker image."
	@echo "  docker-run         - Run the application in a Docker container."
	@echo ""
	@echo "Release:"
	@echo "  release            - Create a new release snapshot using GoReleaser."
	@echo "  version            - Display the current version information."


# ==============================================================================
# Build Targets
# ==============================================================================
build: deps
	@echo "Building Otedama..."
	@mkdir -p $(BIN_DIR)
	$(GOBUILD) $(BUILDFLAGS) $(LDFLAGS_VERSION) -o $(BIN_DIR)/$(BINARY_NAME) ./cmd/otedama

build-all: build build-benchmark build-security

build-benchmark:
	@echo "Building benchmark tool..."
	@mkdir -p $(BIN_DIR)
	$(GOBUILD) $(BUILDFLAGS) $(LDFLAGS) -o $(BIN_DIR)/$(BENCHMARK_BINARY) ./cmd/benchmark

build-security:
	@echo "Building security audit tool..."
	@mkdir -p $(BIN_DIR)
	$(GOBUILD) $(BUILDFLAGS) $(LDFLAGS) -o $(BIN_DIR)/$(SECURITY_BINARY) ./cmd/security-audit

build-race: deps
	@echo "Building with race detector..."
	@mkdir -p $(BIN_DIR)
	$(GOBUILD) -race $(LDFLAGS_VERSION) -o $(BIN_DIR)/$(BINARY_NAME)-race ./cmd/otedama

# ==============================================================================
# Cross-Platform Build Targets
# ==============================================================================
build-cross: build-linux build-windows build-darwin

build-linux:
	@echo "Building for Linux (amd64)..."
	@mkdir -p $(DIST_DIR)/linux
	GOOS=linux GOARCH=amd64 $(GOBUILD) $(BUILDFLAGS) $(LDFLAGS_VERSION) -o $(DIST_DIR)/linux/$(BINARY_NAME) ./cmd/otedama

build-windows:
	@echo "Building for Windows (amd64)..."
	@mkdir -p $(DIST_DIR)/windows
	GOOS=windows GOARCH=amd64 $(GOBUILD) $(BUILDFLAGS) $(LDFLAGS_VERSION) -o $(DIST_DIR)/windows/$(BINARY_WINDOWS) ./cmd/otedama

build-darwin:
	@echo "Building for macOS (amd64)..."
	@mkdir -p $(DIST_DIR)/darwin
	GOOS=darwin GOARCH=amd64 $(GOBUILD) $(BUILDFLAGS) $(LDFLAGS_VERSION) -o $(DIST_DIR)/darwin/$(BINARY_NAME) ./cmd/otedama

# ==============================================================================
# Testing & Quality Assurance
# ==============================================================================
test:
	@echo "Running tests..."
	$(GOTEST) -v -race ./...

coverage:
	@echo "Running tests with coverage..."
	$(GOTEST) -v -race -coverprofile=coverage.txt -covermode=atomic ./...
	@echo "Generating HTML coverage report..."
	$(GOCMD) tool cover -html=coverage.txt -o coverage.html
	@echo "Coverage report generated: coverage.html"

bench:
	@echo "Running benchmarks..."
	$(GOTEST) -bench=. -benchmem ./internal/benchmark/...

lint: | tools
	@echo "Running linter..."
	$(GOLINT) run ./...

fmt:
	@echo "Formatting code..."
	$(GOFMT) -w ./...

vet:
	@echo "Running go vet..."
	$(GOVET) ./...

check: fmt vet lint test

# ==============================================================================
# Dependency & Installation
# ==============================================================================
deps:
	@echo "Downloading dependencies..."
	$(GOMOD) download

tidy:
	@echo "Tidying go modules..."
	$(GOMOD) tidy

verify:
	@echo "Verifying dependencies..."
	$(GOMOD) verify

install: build
	@echo "Installing to $(GOPATH)/bin..."
	@cp $(BIN_DIR)/$(BINARY_NAME) $(GOPATH)/bin/

uninstall:
	@echo "Uninstalling from $(GOPATH)/bin..."
	@rm -f $(GOPATH)/bin/$(BINARY_NAME)

# ==============================================================================
# Development & Execution
# ==============================================================================
run: build
	@echo "Running Otedama..."
	@$(BIN_DIR)/$(BINARY_NAME)

run-config: build
	@echo "Running Otedama with config: $(CONFIG)"
	@$(BIN_DIR)/$(BINARY_NAME) --config $(CONFIG)

watch: | tools
	@echo "Watching for changes..."
	$(AIR)

# ==============================================================================
# Docker Targets
# ==============================================================================
docker:
	@echo "Building Docker image (otedama:$(VERSION), otedama:latest)..."
	docker build -t otedama:$(VERSION) -t otedama:latest .

docker-run:
	@echo "Running Docker container..."
	docker run -it --rm -p 3333:3333 -p 8080:8080 otedama:latest

# ==============================================================================
# Release Targets
# ==============================================================================
release: | tools
	@echo "Creating release snapshot..."
	$(GORELEASER) release --snapshot --rm-dist

version:
	@echo "Version:    $(VERSION)"
	@echo "Build Time: $(BUILD_TIME)"
	@echo "Git Commit: $(GIT_COMMIT)"

# ==============================================================================
# Cleaning
# ==============================================================================
clean:
	@echo "Cleaning build artifacts..."
	$(GOCLEAN) -cache
	@rm -rf $(BIN_DIR) $(BUILD_DIR) $(DIST_DIR)
	@rm -f coverage.txt coverage.html

# ==============================================================================
# Tool Installation (Internal)
# ==============================================================================
tools:
	@echo "Checking for development tools..."
	@if ! which $(GOLINT) > /dev/null; then \
		echo "Installing golangci-lint..."; \
		$(GOGET) github.com/golangci/golangci-lint/cmd/golangci-lint@latest; \
	fi
	@if ! which $(AIR) > /dev/null; then \
		echo "Installing air..."; \
		$(GOGET) github.com/cosmtrek/air@latest; \
	fi
	@if ! which $(GORELEASER) > /dev/null; then \
		echo "Installing goreleaser..."; \
		$(GOGET) github.com/goreleaser/goreleaser@latest; \
	fi
