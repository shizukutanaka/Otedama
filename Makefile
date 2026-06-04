# Otedama Makefile
# Cross-platform build, test, and release automation.
# Usage: make <target>
# Run 'make help' for a list of available targets.

# --------------------------------------------------------------------------
# Variables
# --------------------------------------------------------------------------

# Project metadata
PROJECT := otedama
MODULE := github.com/shizukutanaka/Otedama
VERSION := $(shell cat VERSION 2>/dev/null || echo "v3.0.0-alpha.0-dev")
COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DATE := $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")

# Go settings
GO := go
GOFLAGS := -trimpath
LDFLAGS := -s -w \
	-X '$(MODULE)/internal/version.Version=$(VERSION)' \
	-X '$(MODULE)/internal/version.Commit=$(COMMIT)' \
	-X '$(MODULE)/internal/version.BuildDate=$(BUILD_DATE)'

# Directories
BIN_DIR := ./bin
DIST_DIR := ./dist
COVERAGE_DIR := ./coverage
DOCS_DIR := ./docs

# Default target
.DEFAULT_GOAL := help

# --------------------------------------------------------------------------
# Help
# --------------------------------------------------------------------------

.PHONY: help
help: ## Display this help message
	@echo "Otedama $(VERSION) -- Makefile targets"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' | \
		sort

# --------------------------------------------------------------------------
# Setup
# --------------------------------------------------------------------------

.PHONY: setup
setup: ## Install development tools
	@echo "Installing development tools..."
	$(GO) install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
	$(GO) install github.com/securego/gosec/v2/cmd/gosec@latest
	$(GO) install golang.org/x/vuln/cmd/govulncheck@latest
	$(GO) install github.com/google/go-licenses@latest
	$(GO) install mvdan.cc/gofumpt@latest
	@echo "Development tools installed."

.PHONY: deps
deps: ## Download and verify dependencies
	$(GO) mod download
	$(GO) mod verify
	$(GO) mod tidy

# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------

.PHONY: build
build: ## Build the otedama binary for the current platform
	@mkdir -p $(BIN_DIR)
	$(GO) build $(GOFLAGS) -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(PROJECT) ./cmd/otedama

.PHONY: build-all
build-all: ## Build binaries for all supported platforms
	@mkdir -p $(DIST_DIR)
	@$(MAKE) --no-print-directory _cross-build GOOS=linux GOARCH=amd64
	@$(MAKE) --no-print-directory _cross-build GOOS=linux GOARCH=arm64
	@$(MAKE) --no-print-directory _cross-build GOOS=darwin GOARCH=amd64
	@$(MAKE) --no-print-directory _cross-build GOOS=darwin GOARCH=arm64
	@$(MAKE) --no-print-directory _cross-build GOOS=windows GOARCH=amd64 BIN_EXT=.exe
	@$(MAKE) --no-print-directory _cross-build GOOS=freebsd GOARCH=amd64

.PHONY: _cross-build
_cross-build:
	@echo "Building $(GOOS)/$(GOARCH)..."
	@GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build $(GOFLAGS) -ldflags "$(LDFLAGS)" \
		-o $(DIST_DIR)/$(PROJECT)-$(VERSION)-$(GOOS)-$(GOARCH)$(BIN_EXT) ./cmd/otedama

.PHONY: install
install: build ## Install the binary to $GOPATH/bin
	@cp $(BIN_DIR)/$(PROJECT) $(shell $(GO) env GOPATH)/bin/$(PROJECT)
	@echo "Installed to $(shell $(GO) env GOPATH)/bin/$(PROJECT)"

# --------------------------------------------------------------------------
# Test
# --------------------------------------------------------------------------

.PHONY: test
test: ## Run all tests
	$(GO) test -race -timeout 5m ./...

.PHONY: test-unit
test-unit: ## Run unit tests only (short mode)
	$(GO) test -race -short -timeout 2m ./...

.PHONY: test-integration
test-integration: ## Run integration tests
	$(GO) test -race -timeout 10m -tags=integration ./...

.PHONY: test-e2e
test-e2e: ## Run end-to-end tests
	$(GO) test -race -timeout 15m -tags=e2e ./test/e2e/...

.PHONY: coverage
coverage: ## Generate test coverage report
	@mkdir -p $(COVERAGE_DIR)
	$(GO) test -race -coverprofile=$(COVERAGE_DIR)/coverage.out -covermode=atomic ./...
	$(GO) tool cover -html=$(COVERAGE_DIR)/coverage.out -o $(COVERAGE_DIR)/coverage.html
	$(GO) tool cover -func=$(COVERAGE_DIR)/coverage.out | tail -1
	@echo "Coverage report: $(COVERAGE_DIR)/coverage.html"

.PHONY: bench
bench: ## Run benchmarks
	$(GO) test -bench=. -benchmem -run=^$$ ./...

.PHONY: fuzz
fuzz: ## Run fuzz tests for 30 seconds per target
	@for pkg in $$($(GO) list ./... | xargs -I {} sh -c 'grep -l "func Fuzz" {}/*.go 2>/dev/null | head -1'); do \
		echo "Fuzzing $$pkg..."; \
		$(GO) test -fuzz=. -fuzztime=30s $$pkg || exit 1; \
	done

# --------------------------------------------------------------------------
# Quality
# --------------------------------------------------------------------------

.PHONY: lint
lint: ## Run linters
	golangci-lint run --timeout 5m

.PHONY: lint-fix
lint-fix: ## Run linters with auto-fix
	golangci-lint run --timeout 5m --fix

.PHONY: fmt
fmt: ## Format code
	gofumpt -l -w .
	$(GO) mod tidy

.PHONY: vet
vet: ## Run go vet
	$(GO) vet ./...

.PHONY: security
security: ## Run security scanners
	@echo "Running gosec..."
	gosec -severity medium ./...
	@echo "Running govulncheck..."
	govulncheck ./...
	@echo "Security scan complete."

.PHONY: licenses
licenses: ## Check dependency licenses
	go-licenses check ./... \
		--allowed_licenses=Apache-2.0,MIT,BSD-2-Clause,BSD-3-Clause,ISC,MPL-2.0

.PHONY: validate
validate: fmt vet lint security test coverage ## Run all validation checks
	@echo "All validation checks passed."

.PHONY: audit
audit: ## Run the AUDIT_CHECKLIST verification script
	@echo "==> [1/8] go build ./..."
	@$(GO) build ./...
	@echo "==> [2/8] go test -race -timeout 5m ./..."
	@$(GO) test -race -timeout 5m ./...
	@echo "==> [3/8] go vet ./..."
	@$(GO) vet ./...
	@echo "==> [4/8] govulncheck ./..."
	@command -v govulncheck >/dev/null 2>&1 \
		&& govulncheck ./... \
		|| echo "    (skipped: govulncheck not installed; 'go install golang.org/x/vuln/cmd/govulncheck@latest')"
	@echo "==> [5/8] golangci-lint run"
	@command -v golangci-lint >/dev/null 2>&1 \
		&& golangci-lint run \
		|| echo "    (skipped: golangci-lint not installed)"
	@echo "==> [6/8] grep TODO/FIXME/XXX in non-test code"
	@! git grep -En 'TODO|FIXME|XXX' -- '*.go' ':!*_test.go' \
		|| (echo "    Found TODO/FIXME/XXX markers — annotate with issue refs or resolve" && exit 1)
	@echo "==> [7/8] test:impl ratio"
	@impl=$$(find internal cmd -name '*.go' ! -name '*_test.go' -exec cat {} + | wc -l); \
	tst=$$(find internal cmd -name '*_test.go' -exec cat {} + | wc -l); \
	ratio=$$(echo "scale=3; $$tst / $$impl" | bc); \
	echo "    impl=$$impl test=$$tst ratio=$$ratio"; \
	if [ $$(echo "$$ratio < 1.0" | bc) = "1" ]; then \
		echo "    test:impl ratio below 1.0 threshold" && exit 1; \
	fi
	@echo "==> [8/8] SPDX headers on every Go file"
	@missing=$$(find internal cmd -name '*.go' \
		-exec sh -c 'head -3 "$$1" | grep -q "SPDX-License-Identifier" || echo "$$1"' _ {} \;); \
	if [ -n "$$missing" ]; then \
		echo "    Missing SPDX header in:"; \
		echo "$$missing" | sed 's/^/      /'; \
		echo "    Add the standard header to each file:"; \
		echo "      // SPDX-License-Identifier: Apache-2.0"; \
		echo "      // Copyright 2026 Otedama contributors. See NOTICE for details."; \
		exit 1; \
	fi
	@echo ""
	@echo "All audit checks passed. See docs/AUDIT_CHECKLIST.md for the"
	@echo "full 30-item checklist (manual verification items remain)."

# --------------------------------------------------------------------------
# Docker
# --------------------------------------------------------------------------

.PHONY: docker-build
docker-build: ## Build Docker image
	docker build -t $(PROJECT):$(VERSION) -t $(PROJECT):latest .

.PHONY: docker-run
docker-run: ## Run Otedama in Docker
	docker run --rm -it \
		-v $(PWD)/config.yaml:/etc/otedama/config.yaml:ro \
		$(PROJECT):latest

.PHONY: docker-push
docker-push: ## Push Docker image to registry
	docker push $(PROJECT):$(VERSION)
	docker push $(PROJECT):latest

# --------------------------------------------------------------------------
# Documentation
# --------------------------------------------------------------------------

.PHONY: docs
docs: ## Generate documentation
	$(GO) doc -all ./... > $(DOCS_DIR)/api-reference.txt
	@echo "Documentation generated at $(DOCS_DIR)/"

.PHONY: docs-serve
docs-serve: ## Serve documentation locally on port 6060
	@echo "Starting documentation server at http://localhost:6060/pkg/$(MODULE)/"
	$(GO) run golang.org/x/tools/cmd/godoc@latest -http=:6060

# --------------------------------------------------------------------------
# Release
# --------------------------------------------------------------------------

.PHONY: release-check
release-check: validate ## Verify readiness for release
	@echo "Verifying release readiness..."
	@test -f CHANGELOG.md || (echo "CHANGELOG.md missing" && exit 1)
	@test -f VERSION || (echo "VERSION file missing" && exit 1)
	@grep -q "^## \[$(VERSION)\]\|^## \[Unreleased\]" CHANGELOG.md || \
		(echo "CHANGELOG.md does not contain entry for $(VERSION)" && exit 1)
	@echo "Release checks passed."

.PHONY: release-build
release-build: release-check build-all ## Build release artifacts
	@mkdir -p $(DIST_DIR)
	@echo "Creating checksums..."
	@cd $(DIST_DIR) && sha256sum $(PROJECT)-* > checksums.txt
	@echo "Release artifacts in $(DIST_DIR)/"

.PHONY: tag
tag: ## Create and push git tag for current VERSION
	@echo "Tagging $(VERSION)..."
	@git tag -s $(VERSION) -m "Release $(VERSION)"
	@echo "Run 'git push origin $(VERSION)' to publish the tag."

# --------------------------------------------------------------------------
# Maintenance
# --------------------------------------------------------------------------

.PHONY: clean
clean: ## Remove build artifacts
	rm -rf $(BIN_DIR) $(DIST_DIR) $(COVERAGE_DIR)
	$(GO) clean -cache -testcache

.PHONY: deep-clean
deep-clean: clean ## Remove all generated files including module cache
	$(GO) clean -modcache

.PHONY: deps-upgrade
deps-upgrade: ## Upgrade all dependencies to latest minor/patch versions
	$(GO) get -u ./...
	$(GO) mod tidy
	@echo "Dependencies upgraded. Please run 'make test' to verify."

.PHONY: deps-graph
deps-graph: ## Generate dependency graph
	$(GO) mod graph | head -50

# --------------------------------------------------------------------------
# v2 Migration Support
# --------------------------------------------------------------------------

.PHONY: migrate-from-v2
migrate-from-v2: build ## Migrate v2 configuration to v3 format (requires --v2-config)
	@echo "Use: $(BIN_DIR)/$(PROJECT) migrate-from-v2 --v2-config <path>"
