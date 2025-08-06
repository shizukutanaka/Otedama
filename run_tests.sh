#!/bin/bash

# Otedama Test Runner Script
# Provides comprehensive testing capabilities for the mining pool software

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
VERBOSE=false
PARALLEL=true
FAIL_FAST=false
COVERAGE=false
TIMEOUT="5m"
FILTER=""
CATEGORY=""
TAGS=""
BENCH_TIME="1s"
WORKERS=10
FORMAT="console"

# Function to print colored output
print_color() {
    printf "${1}${2}${NC}\n"
}

# Function to show usage
show_usage() {
    cat << EOF
Otedama Test Runner

Usage: $0 [OPTIONS]

OPTIONS:
    -v, --verbose           Enable verbose output
    -p, --parallel          Run tests in parallel (default: true)
    --no-parallel           Disable parallel execution
    -f, --fail-fast         Stop on first failure
    -c, --coverage          Enable coverage reporting
    -t, --timeout DURATION  Global test timeout (default: 5m)
    --filter PATTERN        Filter tests by name pattern
    --category CATEGORY     Run tests by category (unit,integration,performance)
    --tags TAGS             Run tests with specific tags (comma-separated)
    --bench-time DURATION   Benchmark run time (default: 1s)
    --workers N             Maximum parallel workers (default: 10)
    --format FORMAT         Output format (console,json,junit) (default: console)
    -h, --help              Show this help message

EXAMPLES:
    $0                                    # Run all tests
    $0 -v --coverage                     # Run with verbose output and coverage
    $0 --category unit                   # Run only unit tests
    $0 --tags "mining,pool"              # Run tests tagged with mining or pool
    $0 --filter "*mining*"               # Run tests matching pattern
    $0 --no-parallel --fail-fast         # Run sequentially, stop on first failure
    $0 --format json > results.json      # Output results as JSON

CATEGORIES:
    unit         - Unit tests for individual components
    integration  - Integration tests for component interaction
    performance  - Performance and load tests
    e2e          - End-to-end tests

COMMON TAGS:
    mining       - Mining engine and algorithm tests
    pool         - Mining pool functionality tests
    p2p          - P2P networking tests
    stratum      - Stratum protocol tests
    security     - Security component tests
    config       - Configuration tests
EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -p|--parallel)
            PARALLEL=true
            shift
            ;;
        --no-parallel)
            PARALLEL=false
            shift
            ;;
        -f|--fail-fast)
            FAIL_FAST=true
            shift
            ;;
        -c|--coverage)
            COVERAGE=true
            shift
            ;;
        -t|--timeout)
            TIMEOUT="$2"
            shift 2
            ;;
        --filter)
            FILTER="$2"
            shift 2
            ;;
        --category)
            CATEGORY="$2"
            shift 2
            ;;
        --tags)
            TAGS="$2"
            shift 2
            ;;
        --bench-time)
            BENCH_TIME="$2"
            shift 2
            ;;
        --workers)
            WORKERS="$2"
            shift 2
            ;;
        --format)
            FORMAT="$2"
            shift 2
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        *)
            print_color $RED "Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
done

# Check if Go is installed
if ! command -v go &> /dev/null; then
    print_color $RED "Go is not installed or not in PATH"
    exit 1
fi

# Check if we're in the right directory
if [[ ! -f "go.mod" ]]; then
    print_color $RED "Error: go.mod not found. Please run this script from the project root."
    exit 1
fi

print_color $BLUE "Otedama Test Runner"
print_color $BLUE "=================="

# Build the test runner if it doesn't exist or if source is newer
TEST_RUNNER="./bin/test-runner"
if [[ ! -f "$TEST_RUNNER" ]] || [[ "cmd/test-runner/main.go" -nt "$TEST_RUNNER" ]]; then
    print_color $YELLOW "Building test runner..."
    mkdir -p bin
    if ! go build -o "$TEST_RUNNER" ./cmd/test-runner; then
        print_color $RED "Failed to build test runner"
        exit 1
    fi
    print_color $GREEN "Test runner built successfully"
fi

# Prepare test arguments
TEST_ARGS=()

if [[ "$VERBOSE" == "true" ]]; then
    TEST_ARGS+=("-v")
fi

if [[ "$PARALLEL" == "true" ]]; then
    TEST_ARGS+=("-parallel")
else
    TEST_ARGS+=("-parallel=false")
fi

if [[ "$FAIL_FAST" == "true" ]]; then
    TEST_ARGS+=("-fail-fast")
fi

if [[ "$COVERAGE" == "true" ]]; then
    TEST_ARGS+=("-coverage")
fi

TEST_ARGS+=("-timeout" "$TIMEOUT")
TEST_ARGS+=("-bench-time" "$BENCH_TIME")
TEST_ARGS+=("-workers" "$WORKERS")
TEST_ARGS+=("-format" "$FORMAT")

if [[ -n "$FILTER" ]]; then
    TEST_ARGS+=("-filter" "$FILTER")
fi

if [[ -n "$CATEGORY" ]]; then
    TEST_ARGS+=("-category" "$CATEGORY")
fi

if [[ -n "$TAGS" ]]; then
    TEST_ARGS+=("-tags" "$TAGS")
fi

# Display test configuration
print_color $BLUE "Test Configuration:"
print_color $NC "  Verbose:     $VERBOSE"
print_color $NC "  Parallel:    $PARALLEL"
print_color $NC "  Fail Fast:   $FAIL_FAST"
print_color $NC "  Coverage:    $COVERAGE"
print_color $NC "  Timeout:     $TIMEOUT"
print_color $NC "  Workers:     $WORKERS"
print_color $NC "  Format:      $FORMAT"

if [[ -n "$FILTER" ]]; then
    print_color $NC "  Filter:      $FILTER"
fi

if [[ -n "$CATEGORY" ]]; then
    print_color $NC "  Category:    $CATEGORY"
fi

if [[ -n "$TAGS" ]]; then
    print_color $NC "  Tags:        $TAGS"
fi

echo

# Run tests
print_color $YELLOW "Running tests..."
START_TIME=$(date +%s)

if "$TEST_RUNNER" "${TEST_ARGS[@]}"; then
    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))
    print_color $GREEN "✓ All tests completed successfully in ${DURATION}s"
    exit 0
else
    EXIT_CODE=$?
    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))
    print_color $RED "✗ Tests failed after ${DURATION}s (exit code: $EXIT_CODE)"
    exit $EXIT_CODE
fi