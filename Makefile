# Otedama Makefile

BINARY_NAME=otedama
GO=go
GOFLAGS=-v
LDFLAGS=-ldflags "-w -s"
PLATFORMS=linux/amd64 windows/amd64 darwin/amd64 darwin/arm64

.PHONY: all build clean test bench lint run docker help

all: clean test build

build:
	@echo "Building $(BINARY_NAME)..."
	$(GO) build $(GOFLAGS) $(LDFLAGS) -o bin/$(BINARY_NAME) cmd/otedama/main.go

build-all:
	@echo "Building for all platforms..."
	@for platform in $(PLATFORMS); do \
		GOOS=$${platform%/*} GOARCH=$${platform#*/} \
		$(GO) build $(GOFLAGS) $(LDFLAGS) \
		-o bin/$(BINARY_NAME)-$${platform%/*}-$${platform#*/} \
		cmd/otedama/main.go; \
	done

test:
	@echo "Running tests..."
	$(GO) test -v -race -coverprofile=coverage.out ./...

bench:
	@echo "Running benchmarks..."
	$(GO) test -bench=. -benchmem ./...

lint:
	@echo "Running linter..."
	@which golangci-lint > /dev/null || go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
	golangci-lint run

clean:
	@echo "Cleaning..."
	rm -rf bin/ coverage.out

run:
	@echo "Running $(BINARY_NAME)..."
	$(GO) run cmd/otedama/main.go

docker:
	@echo "Building Docker image..."
	docker build -t otedama:latest .

dev:
	@echo "Running in development mode..."
	@which air > /dev/null || go install github.com/cosmtrek/air@latest
	air

deps:
	@echo "Downloading dependencies..."
	$(GO) mod download
	$(GO) mod tidy

install: build
	@echo "Installing $(BINARY_NAME)..."
	@cp bin/$(BINARY_NAME) /usr/local/bin/

uninstall:
	@echo "Uninstalling $(BINARY_NAME)..."
	@rm -f /usr/local/bin/$(BINARY_NAME)

help:
	@echo "Available targets:"
	@echo "  make build      - Build the binary"
	@echo "  make build-all  - Build for all platforms"
	@echo "  make test       - Run tests"
	@echo "  make bench      - Run benchmarks"
	@echo "  make lint       - Run linter"
	@echo "  make clean      - Clean build artifacts"
	@echo "  make run        - Run the application"
	@echo "  make docker     - Build Docker image"
	@echo "  make dev        - Run in development mode with hot reload"
	@echo "  make deps       - Download dependencies"
	@echo "  make install    - Install binary to /usr/local/bin"
	@echo "  make uninstall  - Remove binary from /usr/local/bin"
	@echo "  make help       - Show this help message"