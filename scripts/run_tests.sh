#!/bin/bash

# Run tests script for Otedama project
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_RESULTS_DIR="${PROJECT_ROOT}/test-results"
COVERAGE_THRESHOLD=80

# Functions
print_header() {
    echo -e "\n${GREEN}========================================${NC}"
    echo -e "${GREEN}$1${NC}"
    echo -e "${GREEN}========================================${NC}\n"
}

print_error() {
    echo -e "${RED}ERROR: $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}WARNING: $1${NC}"
}

print_success() {
    echo -e "${GREEN}SUCCESS: $1${NC}"
}

# Check dependencies
check_dependencies() {
    print_header "Checking Dependencies"
    
    local deps=("go" "docker" "make")
    for dep in "${deps[@]}"; do
        if command -v "$dep" &> /dev/null; then
            echo "✓ $dep is installed"
        else
            print_error "$dep is not installed"
            exit 1
        fi
    done
    
    # Check Go version
    GO_VERSION=$(go version | awk '{print $3}' | sed 's/go//')
    MIN_GO_VERSION="1.21"
    if [ "$(printf '%s\n' "$MIN_GO_VERSION" "$GO_VERSION" | sort -V | head -n1)" != "$MIN_GO_VERSION" ]; then
        print_error "Go version $GO_VERSION is below minimum required version $MIN_GO_VERSION"
        exit 1
    fi
    echo "✓ Go version $GO_VERSION meets requirements"
}

# Setup test environment
setup_test_env() {
    print_header "Setting Up Test Environment"
    
    # Create test results directory
    mkdir -p "$TEST_RESULTS_DIR"
    
    # Start test database if needed
    if [[ "$1" == *"integration"* ]] || [[ "$1" == *"e2e"* ]]; then
        echo "Starting test database..."
        make -f Makefile.test test-db-setup
        sleep 5
    fi
    
    # Set test environment variables
    export GO_ENV=test
    export TEST_POSTGRES_DSN="postgres://test:test@localhost:5432/otedama_test?sslmode=disable"
    export E2E_BASE_URL="http://localhost:8080"
    export E2E_API_KEY="test-api-key"
}

# Cleanup test environment
cleanup_test_env() {
    print_header "Cleaning Up Test Environment"
    
    # Stop test database
    make -f Makefile.test test-db-teardown || true
    
    # Clean test artifacts
    make -f Makefile.test clean-test || true
}

# Run unit tests
run_unit_tests() {
    print_header "Running Unit Tests"
    
    if make -f Makefile.test test-unit; then
        print_success "Unit tests passed"
        return 0
    else
        print_error "Unit tests failed"
        return 1
    fi
}

# Run integration tests
run_integration_tests() {
    print_header "Running Integration Tests"
    
    if make -f Makefile.test test-integration; then
        print_success "Integration tests passed"
        return 0
    else
        print_error "Integration tests failed"
        return 1
    fi
}

# Run E2E tests
run_e2e_tests() {
    print_header "Running E2E Tests"
    
    # Start the application
    echo "Starting application for E2E tests..."
    (cd "$PROJECT_ROOT" && go run cmd/otedama/main.go &)
    APP_PID=$!
    
    # Wait for application to start
    sleep 10
    
    # Run E2E tests
    if make -f Makefile.test test-e2e; then
        print_success "E2E tests passed"
        kill $APP_PID || true
        return 0
    else
        print_error "E2E tests failed"
        kill $APP_PID || true
        return 1
    fi
}

# Run performance tests
run_performance_tests() {
    print_header "Running Performance Tests"
    
    if make -f Makefile.test test-performance; then
        print_success "Performance tests completed"
        
        # Analyze performance results
        if [ -f "$TEST_RESULTS_DIR/performance-test.log" ]; then
            echo -e "\nPerformance Summary:"
            grep -E "(ops/second|latency|throughput)" "$TEST_RESULTS_DIR/performance-test.log" || true
        fi
        return 0
    else
        print_error "Performance tests failed"
        return 1
    fi
}

# Check test coverage
check_coverage() {
    print_header "Checking Test Coverage"
    
    if make -f Makefile.test test-coverage; then
        # Extract coverage percentage
        COVERAGE=$(grep -o '[0-9]*\.[0-9]*%' "$TEST_RESULTS_DIR/coverage-summary.txt" | tail -1 | sed 's/%//')
        
        echo "Overall test coverage: ${COVERAGE}%"
        
        # Check against threshold
        if (( $(echo "$COVERAGE < $COVERAGE_THRESHOLD" | bc -l) )); then
            print_warning "Coverage ${COVERAGE}% is below threshold ${COVERAGE_THRESHOLD}%"
            
            # Show uncovered files
            echo -e "\nFiles with low coverage:"
            grep -E "^[^[:space:]].*\s[0-9]+\.[0-9]+%" "$TEST_RESULTS_DIR/coverage-summary.txt" | \
                awk -v threshold=$COVERAGE_THRESHOLD '$NF ~ /[0-9]+\.[0-9]+%/ {
                    gsub("%", "", $NF);
                    if ($NF < threshold) print $0
                }' || true
            
            return 1
        else
            print_success "Coverage ${COVERAGE}% meets threshold ${COVERAGE_THRESHOLD}%"
            return 0
        fi
    else
        print_error "Failed to generate coverage report"
        return 1
    fi
}

# Generate test report
generate_report() {
    print_header "Generating Test Report"
    
    make -f Makefile.test test-report
    
    # Create summary
    cat > "$TEST_RESULTS_DIR/summary.txt" <<EOF
Test Execution Summary
=====================
Date: $(date)
Branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
Commit: $(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

Test Results:
EOF
    
    # Add test results to summary
    for test_type in unit integration e2e performance; do
        if [ -f "$TEST_RESULTS_DIR/${test_type}-test.log" ]; then
            echo -e "\n${test_type^^} Tests:" >> "$TEST_RESULTS_DIR/summary.txt"
            tail -n 5 "$TEST_RESULTS_DIR/${test_type}-test.log" | grep -E "(PASS|FAIL|ok|ERRO)" >> "$TEST_RESULTS_DIR/summary.txt" || echo "No results" >> "$TEST_RESULTS_DIR/summary.txt"
        fi
    done
    
    echo -e "\nTest report generated at: $TEST_RESULTS_DIR/reports/test-report.md"
    echo "Summary available at: $TEST_RESULTS_DIR/summary.txt"
}

# Main execution
main() {
    local test_suite="${1:-all}"
    local exit_code=0
    
    print_header "Otedama Test Runner"
    echo "Test suite: $test_suite"
    echo "Project root: $PROJECT_ROOT"
    
    # Change to project root
    cd "$PROJECT_ROOT"
    
    # Check dependencies
    check_dependencies
    
    # Setup test environment
    setup_test_env "$test_suite"
    
    # Run tests based on argument
    case "$test_suite" in
        unit)
            run_unit_tests || exit_code=$?
            ;;
        integration)
            run_integration_tests || exit_code=$?
            ;;
        e2e)
            run_e2e_tests || exit_code=$?
            ;;
        performance)
            run_performance_tests || exit_code=$?
            ;;
        coverage)
            run_unit_tests && run_integration_tests && check_coverage || exit_code=$?
            ;;
        all)
            run_unit_tests || exit_code=$?
            run_integration_tests || exit_code=$?
            check_coverage || true # Don't fail on coverage
            ;;
        full)
            run_unit_tests || exit_code=$?
            run_integration_tests || exit_code=$?
            run_e2e_tests || exit_code=$?
            run_performance_tests || exit_code=$?
            check_coverage || exit_code=$?
            ;;
        *)
            print_error "Unknown test suite: $test_suite"
            echo "Available options: unit, integration, e2e, performance, coverage, all, full"
            exit 1
            ;;
    esac
    
    # Generate report
    generate_report
    
    # Cleanup
    cleanup_test_env
    
    # Final summary
    print_header "Test Execution Complete"
    if [ $exit_code -eq 0 ]; then
        print_success "All tests passed!"
    else
        print_error "Some tests failed. Check the logs for details."
    fi
    
    exit $exit_code
}

# Handle interrupts
trap cleanup_test_env INT TERM

# Run main
main "$@"