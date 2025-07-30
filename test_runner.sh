#!/bin/bash
# Otedama Test Runner Script
# Comprehensive test execution with reporting

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test results
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Function to print colored output
print_color() {
    color=$1
    message=$2
    echo -e "${color}${message}${NC}"
}

# Function to run a test suite
run_test_suite() {
    suite_name=$1
    test_command=$2
    
    print_color "$BLUE" "\n=== Running $suite_name ==="
    
    if $test_command; then
        print_color "$GREEN" "✓ $suite_name passed"
        ((PASSED_TESTS++))
    else
        print_color "$RED" "✗ $suite_name failed"
        ((FAILED_TESTS++))
    fi
    ((TOTAL_TESTS++))
}

# Start time
START_TIME=$(date +%s)

print_color "$YELLOW" "Otedama P2P Mining Pool - Test Runner"
print_color "$YELLOW" "====================================="

# Check Go installation
if ! command -v go &> /dev/null; then
    print_color "$RED" "Error: Go is not installed"
    exit 1
fi

print_color "$BLUE" "Go version: $(go version)"

# Clean test cache
print_color "$BLUE" "\nCleaning test cache..."
go clean -testcache

# Create test results directory
mkdir -p test-results

# Run format check
print_color "$BLUE" "\n=== Checking code formatting ==="
if ! gofmt -l . | grep -q .; then
    print_color "$GREEN" "✓ Code formatting is correct"
else
    print_color "$RED" "✗ Code formatting issues found:"
    gofmt -l .
fi

# Run go vet
print_color "$BLUE" "\n=== Running go vet ==="
if go vet ./...; then
    print_color "$GREEN" "✓ go vet passed"
else
    print_color "$RED" "✗ go vet failed"
fi

# Run unit tests
run_test_suite "Unit Tests" "go test -v -short -race -timeout 10m ./internal/... 2>&1 | tee test-results/unit-tests.log"

# Run integration tests
run_test_suite "Integration Tests" "go test -v -race -timeout 20m -run Integration ./tests/integration/... 2>&1 | tee test-results/integration-tests.log"

# Run E2E tests (if not in CI environment)
if [ -z "$CI" ]; then
    run_test_suite "E2E Tests" "go test -v -timeout 30m ./tests/e2e/... 2>&1 | tee test-results/e2e-tests.log"
else
    print_color "$YELLOW" "\nSkipping E2E tests in CI environment"
fi

# Run benchmarks (quick version)
print_color "$BLUE" "\n=== Running benchmarks ==="
if go test -run=XXX -bench=. -benchtime=1s ./... > test-results/benchmarks.log 2>&1; then
    print_color "$GREEN" "✓ Benchmarks completed"
    echo "Benchmark results saved to test-results/benchmarks.log"
else
    print_color "$RED" "✗ Benchmarks failed"
fi

# Generate coverage report
print_color "$BLUE" "\n=== Generating coverage report ==="
if go test -race -coverprofile=test-results/coverage.out -covermode=atomic ./... > /dev/null 2>&1; then
    go tool cover -html=test-results/coverage.out -o test-results/coverage.html
    coverage=$(go tool cover -func=test-results/coverage.out | grep total | awk '{print $3}')
    print_color "$GREEN" "✓ Coverage: $coverage"
    echo "Coverage report saved to test-results/coverage.html"
else
    print_color "$RED" "✗ Coverage generation failed"
fi

# Run security checks if gosec is installed
if command -v gosec &> /dev/null; then
    print_color "$BLUE" "\n=== Running security scan ==="
    if gosec -fmt json -out test-results/security-report.json ./... > /dev/null 2>&1; then
        print_color "$GREEN" "✓ Security scan completed"
        echo "Security report saved to test-results/security-report.json"
    else
        print_color "$YELLOW" "⚠ Security issues found (see test-results/security-report.json)"
    fi
else
    print_color "$YELLOW" "\nSkipping security scan (gosec not installed)"
fi

# Calculate execution time
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

# Print summary
print_color "$YELLOW" "\n====================================="
print_color "$YELLOW" "Test Summary"
print_color "$YELLOW" "====================================="
echo "Total test suites: $TOTAL_TESTS"
print_color "$GREEN" "Passed: $PASSED_TESTS"
if [ $FAILED_TESTS -gt 0 ]; then
    print_color "$RED" "Failed: $FAILED_TESTS"
else
    echo "Failed: 0"
fi
echo "Execution time: ${DURATION}s"

# Generate test report
cat > test-results/test-report.md << EOF
# Otedama Test Report

**Date:** $(date)
**Duration:** ${DURATION}s

## Summary
- Total test suites: $TOTAL_TESTS
- Passed: $PASSED_TESTS
- Failed: $FAILED_TESTS

## Test Results
- Unit Tests: $([ -f test-results/unit-tests.log ] && echo "✓" || echo "✗")
- Integration Tests: $([ -f test-results/integration-tests.log ] && echo "✓" || echo "✗")
- E2E Tests: $([ -f test-results/e2e-tests.log ] && echo "✓" || echo "✗")
- Benchmarks: $([ -f test-results/benchmarks.log ] && echo "✓" || echo "✗")
- Coverage: ${coverage:-N/A}

## Artifacts
- Unit test logs: test-results/unit-tests.log
- Integration test logs: test-results/integration-tests.log
- E2E test logs: test-results/e2e-tests.log
- Benchmark results: test-results/benchmarks.log
- Coverage report: test-results/coverage.html
- Security report: test-results/security-report.json
EOF

print_color "$BLUE" "\nTest report saved to test-results/test-report.md"

# Exit with appropriate code
if [ $FAILED_TESTS -gt 0 ]; then
    exit 1
else
    exit 0
fi