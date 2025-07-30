#!/bin/bash

# Clean up duplicate test directories
echo "Cleaning up test directory structure..."

# Remove duplicate subdirectories
for testdir in unit integration e2e performance security; do
    if [ -d "tests/$testdir" ]; then
        # Keep only the main test files, remove empty subdirectories
        find "tests/$testdir" -type d -empty -delete
        
        # Consolidate test files
        for subdir in api benchmarks data fuzzing load mining mocks network p2p penetration scenarios security smoke system workflows zkp; do
            if [ -d "tests/$testdir/$subdir" ]; then
                # Move any actual test files to the parent directory
                find "tests/$testdir/$subdir" -name "*.go" -exec mv {} "tests/$testdir/" \; 2>/dev/null
                # Remove the subdirectory
                rm -rf "tests/$testdir/$subdir"
            fi
        done
    fi
done

# Remove fixtures directory if empty
find tests/fixtures -type d -empty -delete

echo "Test cleanup complete"