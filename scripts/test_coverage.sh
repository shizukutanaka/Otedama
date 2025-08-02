#!/bin/bash

# Otedama Test Coverage Script
# Runs all tests and generates coverage reports

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Project root
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Coverage output directory
COVERAGE_DIR="coverage"
mkdir -p "$COVERAGE_DIR"

echo -e "${GREEN}=== Otedama Test Coverage Analysis ===${NC}"
echo "Running all tests with coverage..."

# Clean previous coverage files
rm -f "$COVERAGE_DIR"/*.out "$COVERAGE_DIR"/*.html

# Run unit tests with coverage
echo -e "\n${YELLOW}Running unit tests...${NC}"
go test -v -race -coverprofile="$COVERAGE_DIR/unit.out" -covermode=atomic ./internal/...

# Run integration tests with coverage
echo -e "\n${YELLOW}Running integration tests...${NC}"
go test -v -tags=integration -coverprofile="$COVERAGE_DIR/integration.out" -covermode=atomic ./tests/integration/...

# Run e2e tests with coverage  
echo -e "\n${YELLOW}Running e2e tests...${NC}"
go test -v -tags=e2e -coverprofile="$COVERAGE_DIR/e2e.out" -covermode=atomic ./tests/e2e/...

# Merge coverage files
echo -e "\n${YELLOW}Merging coverage reports...${NC}"
echo "mode: atomic" > "$COVERAGE_DIR/coverage.out"
tail -q -n +2 "$COVERAGE_DIR"/*.out >> "$COVERAGE_DIR/coverage.out" 2>/dev/null || true

# Generate HTML report
echo -e "\n${YELLOW}Generating HTML coverage report...${NC}"
go tool cover -html="$COVERAGE_DIR/coverage.out" -o "$COVERAGE_DIR/coverage.html"

# Calculate total coverage
TOTAL_COVERAGE=$(go tool cover -func="$COVERAGE_DIR/coverage.out" | grep total | awk '{print $3}')
echo -e "\n${GREEN}Total Coverage: $TOTAL_COVERAGE${NC}"

# Generate coverage by package
echo -e "\n${YELLOW}Coverage by package:${NC}"
go tool cover -func="$COVERAGE_DIR/coverage.out" | grep -v total | sort -k3 -nr

# Find untested files
echo -e "\n${YELLOW}Finding untested files...${NC}"
UNTESTED_FILES=$(find . -name "*.go" -not -path "./vendor/*" -not -path "./.git/*" -not -name "*_test.go" -not -name "*.pb.go" | while read -r file; do
    pkg=$(go list -f '{{.ImportPath}}' $(dirname "$file") 2>/dev/null)
    if [ -n "$pkg" ]; then
        if ! grep -q "$pkg" "$COVERAGE_DIR/coverage.out" 2>/dev/null; then
            echo "$file"
        fi
    fi
done)

if [ -n "$UNTESTED_FILES" ]; then
    echo -e "${RED}Files with no test coverage:${NC}"
    echo "$UNTESTED_FILES" | head -20
    UNTESTED_COUNT=$(echo "$UNTESTED_FILES" | wc -l)
    if [ "$UNTESTED_COUNT" -gt 20 ]; then
        echo "... and $((UNTESTED_COUNT - 20)) more files"
    fi
else
    echo -e "${GREEN}All files have test coverage!${NC}"
fi

# Run benchmarks
echo -e "\n${YELLOW}Running benchmarks...${NC}"
go test -bench=. -benchmem -run=^# ./... > "$COVERAGE_DIR/benchmarks.txt"
echo "Benchmark results saved to $COVERAGE_DIR/benchmarks.txt"

# Check for race conditions
echo -e "\n${YELLOW}Checking for race conditions...${NC}"
go test -race ./... 2>&1 | tee "$COVERAGE_DIR/race.log"

# Summary
echo -e "\n${GREEN}=== Test Coverage Summary ===${NC}"
echo "Total Coverage: $TOTAL_COVERAGE"
echo "Coverage Report: $COVERAGE_DIR/coverage.html"
echo "Benchmark Results: $COVERAGE_DIR/benchmarks.txt"
echo "Race Detection Log: $COVERAGE_DIR/race.log"

# Set exit code based on coverage threshold
COVERAGE_THRESHOLD=70
COVERAGE_VALUE=$(echo "$TOTAL_COVERAGE" | sed 's/%//')
if (( $(echo "$COVERAGE_VALUE < $COVERAGE_THRESHOLD" | bc -l) )); then
    echo -e "\n${RED}Coverage is below threshold ($COVERAGE_THRESHOLD%)${NC}"
    exit 1
else
    echo -e "\n${GREEN}Coverage meets threshold ($COVERAGE_THRESHOLD%)${NC}"
fi