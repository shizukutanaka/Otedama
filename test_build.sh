#!/bin/bash

echo "Testing build of specific packages..."

# Test mining algorithms package
echo "Testing internal/mining/algorithms..."
go build ./internal/mining/algorithms/... 2>&1 | head -50

# Test optimization package
echo -e "\nTesting internal/optimization..."
go build ./internal/optimization/... 2>&1 | head -50

# Test all packages
echo -e "\nTesting all packages..."
go build ./... 2>&1 | head -100