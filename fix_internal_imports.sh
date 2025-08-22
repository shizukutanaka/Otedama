#!/bin/bash

# Find all Go files with incorrect module imports and replace with relative imports
for file in $(find /mnt/c/Users/irosa/Desktop/Otedama -name "*.go" -type f); do
    # Check if file contains github.com/otedama/otedama imports
    if grep -q "github.com/otedama/otedama/internal" "$file"; then
        # Get the depth of the current file relative to the project root
        depth=$(echo "$file" | sed 's|/mnt/c/Users/irosa/Desktop/Otedama/||' | tr '/' '\n' | wc -l)
        depth=$((depth - 1))
        
        # Generate the relative path prefix
        prefix=""
        if [ $depth -gt 0 ]; then
            for i in $(seq 1 $depth); do
                prefix="../$prefix"
            done
        fi
        
        # For files in cmd/ or at root, use absolute import path
        if echo "$file" | grep -q "/cmd/"; then
            # Files in cmd directory should use module imports
            continue
        elif echo "$file" | grep -q "/internal/"; then
            # Files in internal directory should use relative imports to other internal packages
            # But for simplicity, we'll keep module-style imports for internal packages
            continue
        fi
    fi
done

# Actually, internal packages should be imported using the module path
# So let's just ensure the module path is correct in go.mod
echo "Internal imports should use module path github.com/otedama/otedama"