#!/bin/bash

# Otedama Cleanup Script
# Removes duplicate and unnecessary files

echo "🧹 Otedama Cleanup Script"
echo "========================"

# Files to remove
FILES_TO_REMOVE=(
    # Old TypeScript files
    "examples/api-client.ts.old"
    "examples/custom-algorithm.ts.old"
    "examples/dex-usage.ts.old"
    "examples/enhanced-features.ts.old"
    
    # Duplicate setup scripts
    "setup.bat"
    "setup.sh"
    
    # TypeScript-based start scripts
    "start.bat"
    "start.sh"
    
    # TypeScript build checker
    "scripts/build-status-check.js"
    
    # Duplicate performance test
    "scripts/performance-test.js"
    
    # Temporary file created earlier
    "examples/api-client.ts.old.delete"
)

# Count files
TOTAL=${#FILES_TO_REMOVE[@]}
REMOVED=0

echo "Files to remove: $TOTAL"
echo ""

# Remove each file
for FILE in "${FILES_TO_REMOVE[@]}"; do
    if [ -f "$FILE" ]; then
        rm "$FILE"
        echo "✓ Removed: $FILE"
        ((REMOVED++))
    else
        echo "- Skip: $FILE (not found)"
    fi
done

echo ""
echo "Summary: $REMOVED files removed"

# Clean empty directories
echo ""
echo "Cleaning empty directories..."

# Check if scripts directory is empty
if [ -d "scripts" ] && [ -z "$(ls -A scripts)" ]; then
    rmdir scripts
    echo "✓ Removed empty directory: scripts"
fi

echo ""
echo "✅ Cleanup complete!"
