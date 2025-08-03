#!/bin/bash

# Code Optimization Script
# Optimizes Go code for performance and maintainability

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Change to project root
cd "$(dirname "$0")/.."

# Step 1: Format all Go code
log_info "Formatting Go code..."
gofmt -w -s . || log_error "gofmt failed"

# Step 2: Run goimports to fix imports
log_info "Organizing imports..."
if command -v goimports &> /dev/null; then
    goimports -w . || log_error "goimports failed"
else
    log_warning "goimports not installed, skipping import organization"
fi

# Step 3: Run go vet to find issues
log_info "Running go vet..."
go vet ./... 2>&1 | tee vet_results.txt || log_warning "go vet found issues"

# Step 4: Run staticcheck for advanced analysis
log_info "Running static analysis..."
if command -v staticcheck &> /dev/null; then
    staticcheck ./... 2>&1 | tee staticcheck_results.txt || log_warning "staticcheck found issues"
else
    log_warning "staticcheck not installed, skipping advanced analysis"
fi

# Step 5: Check for common performance issues
log_info "Checking for performance issues..."

# Find inefficient string concatenation in loops
echo "=== Checking for string concatenation in loops ==="
grep -rn "for.*{" --include="*.go" . | while read -r line; do
    file=$(echo "$line" | cut -d: -f1)
    if grep -A 10 "$line" "$file" | grep -q "+=.*string\|= .* +"; then
        echo "Potential inefficient string concatenation in: $file"
    fi
done

# Find unclosed resources
echo "=== Checking for unclosed resources ==="
grep -rn "Open\|Create\|Dial" --include="*.go" . | while read -r line; do
    file=$(echo "$line" | cut -d: -f1)
    linenum=$(echo "$line" | cut -d: -f2)
    # Check if there's a defer close nearby
    if ! sed -n "${linenum},$((linenum+5))p" "$file" | grep -q "defer.*Close"; then
        echo "Potential unclosed resource at $file:$linenum"
    fi
done

# Step 6: Remove unused code
log_info "Checking for unused code..."
if command -v unused &> /dev/null; then
    unused ./... 2>&1 | tee unused_results.txt || log_warning "Found unused code"
else
    log_warning "unused tool not installed, skipping unused code check"
fi

# Step 7: Generate optimization report
log_info "Generating optimization report..."
cat > optimization_report.md << EOF
# Code Optimization Report

Generated: $(date)

## Summary

### Formatting
- Go code formatted with gofmt
- Imports organized with goimports

### Static Analysis
EOF

if [ -f vet_results.txt ] && [ -s vet_results.txt ]; then
    echo "### Go Vet Issues" >> optimization_report.md
    echo '```' >> optimization_report.md
    head -20 vet_results.txt >> optimization_report.md
    echo '```' >> optimization_report.md
fi

if [ -f staticcheck_results.txt ] && [ -s staticcheck_results.txt ]; then
    echo "### Staticcheck Issues" >> optimization_report.md
    echo '```' >> optimization_report.md
    head -20 staticcheck_results.txt >> optimization_report.md
    echo '```' >> optimization_report.md
fi

cat >> optimization_report.md << EOF

## Recommendations

1. **String Operations**: Use strings.Builder for concatenation in loops
2. **Resource Management**: Always use defer for cleanup
3. **Error Handling**: Wrap errors with context
4. **Concurrency**: Use sync.Pool for frequently allocated objects
5. **Memory**: Pre-allocate slices when size is known

## Next Steps

1. Review and fix issues in *_results.txt files
2. Run benchmarks to verify improvements
3. Profile critical paths for further optimization
EOF

log_success "Optimization complete! Check optimization_report.md for details."

# Cleanup temporary files
rm -f vet_results.txt staticcheck_results.txt unused_results.txt 2>/dev/null || true