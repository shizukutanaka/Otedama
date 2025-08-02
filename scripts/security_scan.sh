#!/bin/bash

# Otedama Security Scanning Script
# Performs comprehensive security analysis

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Project root
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Results directory
RESULTS_DIR="security-scan-results"
mkdir -p "$RESULTS_DIR"

echo -e "${BLUE}=== Otedama Security Scanner ===${NC}"
echo "Starting comprehensive security analysis..."

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# 1. Static Code Analysis with gosec
echo -e "\n${YELLOW}[1/8] Running gosec (Go Security Checker)...${NC}"
if command_exists gosec; then
    gosec -fmt json -out "$RESULTS_DIR/gosec-report.json" -stdout -verbose=text -severity high ./... 2>&1 | tee "$RESULTS_DIR/gosec.log"
    gosec_exit_code=${PIPESTATUS[0]}
    
    if [ $gosec_exit_code -eq 0 ]; then
        echo -e "${GREEN}✓ No security issues found by gosec${NC}"
    else
        echo -e "${RED}✗ Security issues detected by gosec${NC}"
        # Parse and display summary
        if command_exists jq; then
            echo "Summary of issues:"
            jq -r '.Issues[] | "- \(.severity): \(.details) in \(.file):\(.line)"' "$RESULTS_DIR/gosec-report.json" 2>/dev/null | head -10
        fi
    fi
else
    echo -e "${RED}gosec not installed. Install with: go install github.com/securego/gosec/v2/cmd/gosec@latest${NC}"
fi

# 2. Dependency Vulnerability Scan
echo -e "\n${YELLOW}[2/8] Scanning dependencies for vulnerabilities...${NC}"
if command_exists nancy; then
    go list -json -deps ./... | nancy sleuth -o json > "$RESULTS_DIR/nancy-report.json" 2>&1
    nancy_exit_code=$?
    
    if [ $nancy_exit_code -eq 0 ]; then
        echo -e "${GREEN}✓ No vulnerable dependencies found${NC}"
    else
        echo -e "${RED}✗ Vulnerable dependencies detected${NC}"
        go list -json -deps ./... | nancy sleuth 2>&1 | grep -E "(High|Critical)" | head -10
    fi
else
    # Alternative: use go mod audit
    go list -m all | while read -r module version; do
        if [ ! -z "$module" ]; then
            go mod download -json "$module@$version" 2>/dev/null | jq -r '.Error' 2>/dev/null | grep -v null
        fi
    done
fi

# 3. Secret Detection
echo -e "\n${YELLOW}[3/8] Scanning for secrets and credentials...${NC}"
if command_exists trufflehog; then
    trufflehog filesystem . --json --no-update > "$RESULTS_DIR/trufflehog-report.json" 2>&1
    
    if [ -s "$RESULTS_DIR/trufflehog-report.json" ]; then
        echo -e "${RED}✗ Potential secrets detected${NC}"
        jq -r '.SourceMetadata.Data.Filesystem.file' "$RESULTS_DIR/trufflehog-report.json" 2>/dev/null | sort | uniq | head -10
    else
        echo -e "${GREEN}✓ No secrets detected${NC}"
    fi
else
    # Basic secret patterns
    echo "Checking for common secret patterns..."
    grep -rEn "(api[_-]?key|secret|token|password|pwd|passwd|private[_-]?key)" \
        --include="*.go" --include="*.yaml" --include="*.yml" --include="*.json" \
        --exclude-dir=vendor --exclude-dir=.git . 2>/dev/null | \
        grep -v -E "(test|example|sample|dummy|fake)" | \
        head -10 > "$RESULTS_DIR/secret-patterns.txt"
    
    if [ -s "$RESULTS_DIR/secret-patterns.txt" ]; then
        echo -e "${RED}✗ Potential secret patterns found:${NC}"
        cat "$RESULTS_DIR/secret-patterns.txt"
    else
        echo -e "${GREEN}✓ No obvious secret patterns found${NC}"
    fi
fi

# 4. License Compliance Check
echo -e "\n${YELLOW}[4/8] Checking license compliance...${NC}"
if command_exists go-licenses; then
    go-licenses report ./... --template "$RESULTS_DIR/licenses.csv" 2>&1
    
    # Check for problematic licenses
    problematic=$(grep -E "(GPL|AGPL|SSPL)" "$RESULTS_DIR/licenses.csv" 2>/dev/null || true)
    if [ ! -z "$problematic" ]; then
        echo -e "${YELLOW}⚠ Found potentially problematic licenses:${NC}"
        echo "$problematic"
    else
        echo -e "${GREEN}✓ No problematic licenses found${NC}"
    fi
else
    echo "go-licenses not installed. Install with: go install github.com/google/go-licenses@latest"
fi

# 5. SAST with semgrep
echo -e "\n${YELLOW}[5/8] Running semgrep security rules...${NC}"
if command_exists semgrep; then
    semgrep --config=auto --json -o "$RESULTS_DIR/semgrep-report.json" . 2>&1
    
    if [ -f "$RESULTS_DIR/semgrep-report.json" ]; then
        findings=$(jq '.results | length' "$RESULTS_DIR/semgrep-report.json" 2>/dev/null || echo "0")
        if [ "$findings" -gt 0 ]; then
            echo -e "${RED}✗ Found $findings security findings${NC}"
            jq -r '.results[] | "- \(.check_id): \(.path):\(.start.line)"' "$RESULTS_DIR/semgrep-report.json" 2>/dev/null | head -10
        else
            echo -e "${GREEN}✓ No security findings from semgrep${NC}"
        fi
    fi
else
    echo "semgrep not installed. Install with: pip install semgrep"
fi

# 6. Container Security Scan (if Dockerfile exists)
echo -e "\n${YELLOW}[6/8] Scanning container configuration...${NC}"
if [ -f "Dockerfile" ]; then
    if command_exists hadolint; then
        hadolint Dockerfile > "$RESULTS_DIR/hadolint-report.txt" 2>&1 || true
        
        if [ -s "$RESULTS_DIR/hadolint-report.txt" ]; then
            echo -e "${YELLOW}⚠ Container security issues:${NC}"
            cat "$RESULTS_DIR/hadolint-report.txt" | head -10
        else
            echo -e "${GREEN}✓ No container configuration issues${NC}"
        fi
    fi
    
    # Check for security best practices
    echo "Checking Dockerfile security best practices..."
    
    # Non-root user
    if ! grep -q "USER" Dockerfile; then
        echo -e "${RED}✗ Container runs as root user${NC}"
    fi
    
    # Minimal base image
    if grep -qE "(ubuntu|debian|centos)" Dockerfile && ! grep -qE "(alpine|distroless|scratch)" Dockerfile; then
        echo -e "${YELLOW}⚠ Consider using minimal base image${NC}"
    fi
fi

# 7. Code Quality and Complexity
echo -e "\n${YELLOW}[7/8] Analyzing code complexity...${NC}"
if command_exists gocyclo; then
    echo "Functions with high cyclomatic complexity:"
    gocyclo -over 15 . 2>/dev/null | head -10 > "$RESULTS_DIR/complexity.txt"
    
    if [ -s "$RESULTS_DIR/complexity.txt" ]; then
        cat "$RESULTS_DIR/complexity.txt"
    else
        echo -e "${GREEN}✓ No overly complex functions found${NC}"
    fi
else
    echo "gocyclo not installed. Install with: go install github.com/fzipp/gocyclo/cmd/gocyclo@latest"
fi

# 8. Custom Security Checks
echo -e "\n${YELLOW}[8/8] Running custom security checks...${NC}"

# Check for unsafe package usage
echo "Checking for unsafe package usage..."
unsafe_usage=$(grep -rn "unsafe\." --include="*.go" . 2>/dev/null | grep -v "test" || true)
if [ ! -z "$unsafe_usage" ]; then
    echo -e "${YELLOW}⚠ Found unsafe package usage:${NC}"
    echo "$unsafe_usage" | head -5
fi

# Check for weak crypto
echo "Checking for weak cryptography..."
weak_crypto=$(grep -rEn "(md5|sha1|DES|RC4)" --include="*.go" . 2>/dev/null | grep -v "test" || true)
if [ ! -z "$weak_crypto" ]; then
    echo -e "${YELLOW}⚠ Found potentially weak cryptography:${NC}"
    echo "$weak_crypto" | head -5
fi

# Check for SQL queries
echo "Checking for potential SQL injection..."
sql_queries=$(grep -rEn "(Exec|Query|Prepare).*\+|fmt\.Sprintf.*(?i)(select|insert|update|delete)" --include="*.go" . 2>/dev/null || true)
if [ ! -z "$sql_queries" ]; then
    echo -e "${YELLOW}⚠ Found potential SQL injection points:${NC}"
    echo "$sql_queries" | head -5
fi

# Generate Summary Report
echo -e "\n${BLUE}=== Security Scan Summary ===${NC}"
echo "Scan completed at: $(date)"
echo "Results saved to: $RESULTS_DIR/"

# Create summary report
cat > "$RESULTS_DIR/SECURITY_SUMMARY.md" << EOF
# Otedama Security Scan Report

Generated: $(date)

## Scan Results Summary

### Static Analysis (gosec)
$(if [ -f "$RESULTS_DIR/gosec-report.json" ]; then
    issues=$(jq '.Stats.found' "$RESULTS_DIR/gosec-report.json" 2>/dev/null || echo "0")
    echo "- Total issues found: $issues"
fi)

### Dependency Vulnerabilities
$(if [ -f "$RESULTS_DIR/nancy-report.json" ]; then
    vulns=$(jq '. | length' "$RESULTS_DIR/nancy-report.json" 2>/dev/null || echo "0")
    echo "- Vulnerable dependencies: $vulns"
fi)

### Secret Detection
$(if [ -f "$RESULTS_DIR/trufflehog-report.json" ]; then
    secrets=$(jq '. | length' "$RESULTS_DIR/trufflehog-report.json" 2>/dev/null || echo "0")
    echo "- Potential secrets: $secrets"
fi)

### License Compliance
$(if [ -f "$RESULTS_DIR/licenses.csv" ]; then
    total=$(wc -l < "$RESULTS_DIR/licenses.csv")
    echo "- Total dependencies: $total"
fi)

## Recommendations

1. Review and fix all high and critical severity findings
2. Update vulnerable dependencies
3. Remove or secure any exposed secrets
4. Ensure proper input validation and sanitization
5. Use parameterized queries for database operations
6. Implement proper authentication and authorization
7. Enable security headers and CORS policies
8. Regular security updates and patches

## Next Steps

1. Fix critical issues immediately
2. Schedule regular security scans
3. Implement security testing in CI/CD pipeline
4. Conduct penetration testing
5. Security training for development team
EOF

echo -e "\n${GREEN}Security scan complete!${NC}"
echo "Review the detailed reports in: $RESULTS_DIR/"
echo "Summary report: $RESULTS_DIR/SECURITY_SUMMARY.md"

# Exit with appropriate code
if [ -f "$RESULTS_DIR/gosec-report.json" ]; then
    critical_issues=$(jq '[.Issues[] | select(.severity == "HIGH" or .severity == "CRITICAL")] | length' "$RESULTS_DIR/gosec-report.json" 2>/dev/null || echo "0")
    if [ "$critical_issues" -gt 0 ]; then
        echo -e "\n${RED}Found $critical_issues critical security issues!${NC}"
        exit 1
    fi
fi

echo -e "\n${GREEN}No critical security issues found.${NC}"
exit 0