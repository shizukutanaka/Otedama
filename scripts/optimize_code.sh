#!/bin/bash
# Otedama Code Optimization and Organization Script
# Improves code readability and structure

set -e

echo "🔧 Otedama Code Optimization Tool"
echo "================================="

# Color codes for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Function to format Go code
format_go_code() {
    echo -e "${BLUE}📝 Formatting Go code...${NC}"
    
    # Run gofmt on all Go files
    find . -name "*.go" -type f -not -path "./vendor/*" -not -path "./_deleted_backup/*" | while read -r file; do
        echo -n "  Formatting: $file ... "
        gofmt -w -s "$file"
        echo -e "${GREEN}✓${NC}"
    done
    
    # Run goimports to organize imports
    if command -v goimports &> /dev/null; then
        echo -e "${BLUE}📦 Organizing imports...${NC}"
        find . -name "*.go" -type f -not -path "./vendor/*" -not -path "./_deleted_backup/*" | while read -r file; do
            echo -n "  Organizing: $file ... "
            goimports -w "$file"
            echo -e "${GREEN}✓${NC}"
        done
    else
        echo -e "${YELLOW}⚠️  goimports not found. Install with: go install golang.org/x/tools/cmd/goimports@latest${NC}"
    fi
}

# Function to add package documentation
add_package_docs() {
    echo -e "${BLUE}📚 Adding package documentation...${NC}"
    
    # Find packages without doc.go
    find ./internal -type d -not -path "*/\.*" | while read -r dir; do
        if [ ! -f "$dir/doc.go" ] && ls "$dir"/*.go &> /dev/null 2>&1; then
            pkg_name=$(basename "$dir")
            echo -n "  Creating doc.go for package $pkg_name ... "
            
            cat > "$dir/doc.go" << EOF
// Package $pkg_name provides functionality for $(echo $pkg_name | sed 's/_/ /g').
//
// This package is part of the Otedama mining pool system.
package $pkg_name
EOF
            echo -e "${GREEN}✓${NC}"
        fi
    done
}

# Function to organize test files
organize_tests() {
    echo -e "${BLUE}🧪 Organizing test files...${NC}"
    
    # Create test directories if they don't exist
    mkdir -p tests/unit
    mkdir -p tests/integration
    mkdir -p tests/benchmark
    
    echo -e "${GREEN}✓ Test directories ready${NC}"
}

# Function to create code style guide
create_style_guide() {
    echo -e "${BLUE}📋 Creating code style guide...${NC}"
    
    cat > STYLE_GUIDE.md << 'EOF'
# Otedama Code Style Guide

## Go Code Standards

### 1. File Organization
- Package declaration
- Import statements (grouped: standard library, external, internal)
- Constants
- Types
- Global variables (avoid when possible)
- Functions (exported first, then internal)

### 2. Naming Conventions
- **Packages**: lowercase, single word (e.g., `mining`, `security`)
- **Files**: snake_case (e.g., `mining_engine.go`, `zkp_verifier.go`)
- **Types**: PascalCase (e.g., `MiningEngine`, `SecurityManager`)
- **Functions**: PascalCase for exported, camelCase for internal
- **Variables**: camelCase
- **Constants**: PascalCase or UPPER_SNAKE_CASE for groups

### 3. Comments
- Package documentation in doc.go files
- Exported functions must have comments starting with the function name
- Complex logic should have inline comments
- Use TODO/FIXME/NOTE markers consistently

### 4. Error Handling
```go
// Good
if err != nil {
    return fmt.Errorf("failed to process: %w", err)
}

// Bad
if err != nil {
    return err
}
```

### 5. Interface Design
- Keep interfaces small and focused
- Define interfaces where they are used, not where implemented
- Use interface{} sparingly, prefer specific types

### 6. Testing
- Test files should be in the same package
- Use table-driven tests for multiple scenarios
- Benchmark critical paths
- Mock external dependencies

### 7. Performance Guidelines
- Pre-allocate slices when size is known
- Use sync.Pool for frequently allocated objects
- Profile before optimizing
- Document performance-critical sections

### 8. Security Practices
- Never log sensitive information
- Always validate input
- Use constant-time comparisons for secrets
- Implement proper timeout handling

## Directory Structure

```
internal/
├── core/           # Core system logic
├── mining/         # Mining implementation
├── security/       # Security layers
├── api/           # REST API
├── monitoring/    # System monitoring
└── [module]/      # Other modules
    ├── doc.go     # Package documentation
    ├── types.go   # Type definitions
    ├── [module].go # Main implementation
    └── [module]_test.go # Tests
```

## Git Commit Messages

Format: `<type>(<scope>): <subject>`

Types:
- feat: New feature
- fix: Bug fix
- docs: Documentation
- style: Code style changes
- refactor: Code refactoring
- perf: Performance improvements
- test: Test changes
- chore: Build/maintenance tasks

Example: `feat(mining): add RandomX algorithm support`
EOF
    
    echo -e "${GREEN}✓ Style guide created${NC}"
}

# Function to check code quality
check_code_quality() {
    echo -e "${BLUE}🔍 Checking code quality...${NC}"
    
    # Run go vet
    echo -n "  Running go vet ... "
    if go vet ./... 2>&1 | grep -q .; then
        echo -e "${YELLOW}⚠️  Issues found${NC}"
    else
        echo -e "${GREEN}✓${NC}"
    fi
    
    # Check for inefficient code patterns
    if command -v ineffassign &> /dev/null; then
        echo -n "  Running ineffassign ... "
        if ineffassign ./... 2>&1 | grep -q .; then
            echo -e "${YELLOW}⚠️  Inefficient assignments found${NC}"
        else
            echo -e "${GREEN}✓${NC}"
        fi
    fi
    
    # Check for misspellings
    if command -v misspell &> /dev/null; then
        echo -n "  Running misspell ... "
        if misspell -w ./... 2>&1 | grep -q .; then
            echo -e "${YELLOW}⚠️  Misspellings corrected${NC}"
        else
            echo -e "${GREEN}✓${NC}"
        fi
    fi
}

# Function to generate module documentation
generate_module_docs() {
    echo -e "${BLUE}📖 Generating module documentation...${NC}"
    
    cat > docs/MODULES.md << 'EOF'
# Otedama Module Documentation

## Core Modules

### 🔧 Core (`/internal/core`)
Central system orchestration and lifecycle management.

### ⛏️ Mining (`/internal/mining`)
Mining engine with support for 16 different algorithms.

### 🔒 Security (`/internal/security`)
Multi-layered security implementation including encryption, firewall, and IDS.

### 🔐 ZKP (`/internal/zkp`)
Zero-knowledge proof systems for privacy-preserving authentication.

### 📊 Monitoring (`/internal/monitoring`)
Comprehensive system monitoring with Prometheus integration.

### 🌐 API (`/internal/api`)
RESTful API for external integrations.

### 💻 Dashboard (`/internal/dashboard`)
Web-based management interface.

### 🤖 Automation (`/internal/automation`)
Self-healing and auto-scaling capabilities.

## Module Dependencies

```mermaid
graph TD
    A[Core] --> B[Mining]
    A --> C[Security]
    A --> D[Monitoring]
    B --> E[Stratum]
    B --> F[P2P]
    C --> G[ZKP]
    D --> H[API]
    D --> I[Dashboard]
```

## Best Practices

1. **Loose Coupling**: Modules communicate through interfaces
2. **Single Responsibility**: Each module has a clear, focused purpose
3. **Dependency Injection**: Dependencies are injected, not created
4. **Error Propagation**: Errors are wrapped with context
5. **Resource Management**: Proper cleanup in shutdown methods
EOF
    
    echo -e "${GREEN}✓ Module documentation generated${NC}"
}

# Main execution
main() {
    echo "Starting code optimization..."
    echo
    
    # Run all optimization steps
    format_go_code
    echo
    
    add_package_docs
    echo
    
    organize_tests
    echo
    
    create_style_guide
    echo
    
    check_code_quality
    echo
    
    generate_module_docs
    echo
    
    echo -e "${GREEN}✅ Code optimization complete!${NC}"
    echo
    echo "Next steps:"
    echo "  1. Review STYLE_GUIDE.md for coding standards"
    echo "  2. Check docs/MODULES.md for module documentation"
    echo "  3. Run 'go test ./...' to ensure tests pass"
    echo "  4. Consider installing additional tools:"
    echo "     - goimports: go install golang.org/x/tools/cmd/goimports@latest"
    echo "     - ineffassign: go install github.com/gordonklaus/ineffassign@latest"
    echo "     - misspell: go install github.com/client9/misspell/cmd/misspell@latest"
}

# Run main function
main